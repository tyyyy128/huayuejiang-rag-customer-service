const http = require('http');


/*
 * =======================================================
 * 基础配置
 * =======================================================
 */

const PORT =
  Number(
    process.env.PORT ||
    8787
  );


const RAGFLOW_BASE_URL =
  process.env.RAGFLOW_BASE_URL ||
  'http://127.0.0.1';


const RAGFLOW_API_KEY =
  process.env.RAGFLOW_API_KEY;


const RAGFLOW_AGENT_ID =
  process.env.RAGFLOW_AGENT_ID;


const RATE_LIMIT_WINDOW_MS =
  Number(
    process.env.RATE_LIMIT_WINDOW_MS ||
    60000
  );


const RATE_LIMIT_MAX_REQUESTS =
  Number(
    process.env.RATE_LIMIT_MAX_REQUESTS ||
    10
  );


const MAX_CONCURRENT_PER_IP =
  Number(
    process.env.MAX_CONCURRENT_PER_IP ||
    2
  );


const RAGFLOW_TIMEOUT_MS =
  Number(
    process.env.RAGFLOW_TIMEOUT_MS ||
    90000
  );


/*
 * UserFillUp 等待状态保留时间。
 *
 * 默认 2 小时。
 *
 * 防止：
 * pendingUserInputs
 * 长时间运行后无限增长。
 */
const PENDING_INPUT_TTL_MS =
  Number(
    process.env.PENDING_INPUT_TTL_MS ||
    2 * 60 * 60 * 1000
  );



/*
 * =======================================================
 * 启动前检查
 * =======================================================
 */

if (!RAGFLOW_API_KEY) {

  console.error(
    'Missing RAGFLOW_API_KEY'
  );

  process.exit(1);
}


if (!RAGFLOW_AGENT_ID) {

  console.error(
    'Missing RAGFLOW_AGENT_ID'
  );

  process.exit(1);
}



/*
 * =======================================================
 * 内存状态
 * =======================================================
 */


/*
 * IP 请求频率。
 */
const rateLimitStore =
  new Map();


/*
 * IP 当前并发请求数。
 */
const concurrentStore =
  new Map();


/*
 * =======================================================
 * RAGFlow UserFillUp 等待状态
 * =======================================================
 *
 * key:
 *
 * sessionId
 *
 *
 * value:
 *
 * {
 *   inputKeys: [
 *     'additional_info'
 *   ],
 *
 *   updatedAt:
 *     123456789
 * }
 *
 *
 * 当 RAGFlow 返回：
 *
 * event = user_inputs
 *
 * Gateway 会把仍待填写的字段记录下来。
 *
 *
 * 下一轮：
 *
 * query = 用户本轮原话
 *
 * 同时：
 *
 * inputs.xxx = 用户本轮原话
 *
 *
 * 这样才能真正恢复
 * UserFillUp 工作流。
 */

const pendingUserInputs =
  new Map();



/*
 * =======================================================
 * 获取真实客户端 IP
 * =======================================================
 *
 * Cloudflare Tunnel 会提供：
 *
 * cf-connecting-ip
 *
 *
 * 当前 Gateway 只监听：
 *
 * 127.0.0.1
 *
 *
 * 所以公网流量会经过：
 *
 * Cloudflare
 * →
 * cloudflared
 * →
 * Gateway
 */

function getClientIp(req) {

  const cfIp =
    req.headers[
      'cf-connecting-ip'
    ];


  /*
   * Cloudflare 真实客户端 IP。
   */
  if (
    typeof cfIp === 'string' &&
    cfIp.trim()
  ) {

    return cfIp.trim();
  }



  /*
   * 兼容其他反向代理。
   */

  const forwardedFor =
    req.headers[
      'x-forwarded-for'
    ];


  if (
    typeof forwardedFor === 'string' &&
    forwardedFor.trim()
  ) {

    return forwardedFor
      .split(',')[0]
      .trim();
  }



  /*
   * 本机直接请求。
   */

  let ip =
    req.socket?.remoteAddress ||
    'unknown';


  /*
   * IPv4 mapped IPv6：
   *
   * ::ffff:127.0.0.1
   *
   * 转成：
   *
   * 127.0.0.1
   */

  if (
    ip.startsWith(
      '::ffff:'
    )
  ) {

    ip =
      ip.slice(7);
  }


  return ip;
}



/*
 * =======================================================
 * 请求频率限流
 * =======================================================
 */

function checkRateLimit(ip) {

  const now =
    Date.now();


  let record =
    rateLimitStore.get(ip);



  /*
   * 新窗口。
   */

  if (
    !record ||
    now -
      record.windowStart >=
      RATE_LIMIT_WINDOW_MS
  ) {

    record = {

      windowStart:
        now,


      count:
        0
    };


    rateLimitStore.set(
      ip,
      record
    );
  }



  /*
   * 已达到限制。
   */

  if (
    record.count >=
    RATE_LIMIT_MAX_REQUESTS
  ) {

    const retryAfterMs =
      RATE_LIMIT_WINDOW_MS -
      (
        now -
        record.windowStart
      );


    return {

      allowed:
        false,


      retryAfterSeconds:
        Math.max(
          1,

          Math.ceil(
            retryAfterMs /
            1000
          )
        )
    };
  }



  record.count +=
    1;


  return {

    allowed:
      true,


    remaining:
      RATE_LIMIT_MAX_REQUESTS -
      record.count
  };
}



/*
 * =======================================================
 * 同 IP 并发限制
 * =======================================================
 */

function acquireConcurrentSlot(ip) {

  const current =
    concurrentStore.get(ip) ||
    0;


  if (
    current >=
    MAX_CONCURRENT_PER_IP
  ) {

    return false;
  }


  concurrentStore.set(
    ip,
    current + 1
  );


  return true;
}



function releaseConcurrentSlot(ip) {

  const current =
    concurrentStore.get(ip) ||
    0;


  if (
    current <= 1
  ) {

    concurrentStore.delete(
      ip
    );

    return;
  }


  concurrentStore.set(
    ip,
    current - 1
  );
}



/*
 * =======================================================
 * 定期清理缓存状态
 * =======================================================
 */

setInterval(
  () => {

    const now =
      Date.now();



    /*
     * 清理过期限流记录。
     */

    for (
      const [
        ip,
        record
      ]
      of
      rateLimitStore.entries()
    ) {

      if (
        now -
          record.windowStart >
        RATE_LIMIT_WINDOW_MS *
          2
      ) {

        rateLimitStore.delete(
          ip
        );
      }
    }



    /*
     * 清理长期未继续的
     * UserFillUp session。
     */

    for (
      const [
        sessionId,
        record
      ]
      of
      pendingUserInputs.entries()
    ) {

      if (
        now -
          record.updatedAt >
        PENDING_INPUT_TTL_MS
      ) {

        pendingUserInputs.delete(
          sessionId
        );
      }
    }

  },

  Math.min(
    RATE_LIMIT_WINDOW_MS,
    60000
  )

).unref();



/*
 * =======================================================
 * JSON HTTP 返回
 * =======================================================
 */

function sendJson(
  res,
  statusCode,
  data,
  extraHeaders = {}
) {

  const body =
    JSON.stringify(
      data
    );


  res.writeHead(
    statusCode,
    {

      'Content-Type':
        'application/json; charset=utf-8',


      'Access-Control-Allow-Origin':
        '*',


      'Access-Control-Allow-Headers':
        'Content-Type',


      'Access-Control-Allow-Methods':
        'GET,POST,OPTIONS',


      'Cache-Control':
        'no-store',


      'X-Content-Type-Options':
        'nosniff',


      ...extraHeaders
    }
  );


  res.end(
    body
  );
}



/*
 * =======================================================
 * 读取 JSON Body
 * =======================================================
 */

function readJsonBody(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let body =
        '';


      let size =
        0;


      let rejected =
        false;



      req.on(
        'data',

        chunk => {

          if (rejected) {

            return;
          }



          size +=
            chunk.length;



          /*
           * 最大请求 Body：
           *
           * 64 KB
           */

          if (
            size >
            64 * 1024
          ) {

            rejected =
              true;


            reject(
              new Error(
                'REQUEST_TOO_LARGE'
              )
            );


            return;
          }



          body +=
            chunk;
        }
      );



      req.on(
        'end',

        () => {

          if (rejected) {

            return;
          }



          try {

            resolve(

              body

                ? JSON.parse(
                    body
                  )

                : {}
            );


          } catch {

            reject(
              new Error(
                'INVALID_JSON'
              )
            );
          }
        }
      );



      req.on(
        'error',
        reject
      );
    }
  );
}



/*
 * =======================================================
 * 安全文本提取
 * =======================================================
 *
 * 只读取可能面向用户展示的文本字段。
 *
 *
 * 不自动序列化：
 *
 * structured
 * reference
 * inputs
 * 内部节点对象
 *
 *
 * 防止把 RAGFlow 内部内容
 * 直接暴露给小程序。
 */

function extractText(
  value,
  depth = 0
) {

  if (
    value === null ||
    value === undefined
  ) {

    return '';
  }



  /*
   * 防止异常递归。
   */

  if (
    depth > 8
  ) {

    return '';
  }



  /*
   * 字符串。
   */

  if (
    typeof value ===
    'string'
  ) {

    return value.trim();
  }



  /*
   * 简单值。
   */

  if (
    typeof value ===
      'number' ||

    typeof value ===
      'boolean'
  ) {

    return String(
      value
    );
  }



  /*
   * 数组。
   */

  if (
    Array.isArray(
      value
    )
  ) {

    return value
      .map(
        item =>
          extractText(
            item,
            depth + 1
          )
      )
      .filter(
        Boolean
      )
      .join('\n')
      .trim();
  }



  /*
   * 对象。
   */

  if (
    typeof value ===
    'object'
  ) {

    const preferredKeys = [

      'content',

      'text',

      'message',

      'prompt',

      'question',

      'tip',

      'tips',

      'label',

      'title',

      'description',

      'placeholder',

      'value'
    ];



    for (
      const key
      of
      preferredKeys
    ) {

      if (
        Object.prototype
          .hasOwnProperty
          .call(
            value,
            key
          )
      ) {

        const text =
          extractText(
            value[key],
            depth + 1
          );


        if (text) {

          return text;
        }
      }
    }
  }


  return '';
}



/*
 * =======================================================
 * 提取 RAGFlow user_inputs 字段名
 * =======================================================
 *
 * RAGFlow 返回类似：
 *
 * data.inputs = {
 *   additional_info: ...
 * }
 *
 * 或：
 *
 * data.inputs = {
 *   followup_query: ...
 * }
 *
 *
 * 这里记录真正缺失的字段名。
 */

function getPendingInputKeys(
  nodeData
) {

  const inputs =
    nodeData?.inputs;



  if (!inputs) {

    return [];
  }



  /*
   * 正常情况：
   *
   * inputs 是对象。
   */

  if (
    typeof inputs ===
      'object' &&

    !Array.isArray(
      inputs
    )
  ) {

    return Object.keys(
      inputs
    ).filter(
      Boolean
    );
  }



  /*
   * 做一层兼容：
   *
   * 如果未来返回数组形式。
   */

  if (
    Array.isArray(
      inputs
    )
  ) {

    return inputs
      .map(
        item => {

          if (
            typeof item ===
            'string'
          ) {

            return item.trim();
          }



          if (
            item &&
            typeof item ===
              'object'
          ) {

            return (
              item.name ||
              item.key ||
              item.id ||
              item.variable ||
              ''
            )
              .toString()
              .trim();
          }


          return '';
        }
      )
      .filter(
        Boolean
      );
  }


  return [];
}



/*
 * =======================================================
 * 记录等待输入状态
 * =======================================================
 */

function rememberPendingInputs(
  sessionId,
  nodeData
) {

  if (!sessionId) {

    return [];
  }



  const inputKeys =
    getPendingInputKeys(
      nodeData
    );



  /*
   * 正常记录。
   */

  if (
    inputKeys.length > 0
  ) {

    pendingUserInputs.set(
      sessionId,
      {

        inputKeys,


        updatedAt:
          Date.now()
      }
    );

  } else {

    /*
     * 如果没有字段，
     * 不保留错误旧状态。
     */

    pendingUserInputs.delete(
      sessionId
    );
  }


  return inputKeys;
}



/*
 * =======================================================
 * 清除等待状态
 * =======================================================
 */

function clearPendingInputs(
  sessionId
) {

  if (!sessionId) {

    return;
  }


  pendingUserInputs.delete(
    sessionId
  );
}



/*
 * =======================================================
 * 调用 RAGFlow Agent API
 * =======================================================
 */

async function callRagflow(
  message,
  sessionId
) {

  /*
   * 基础请求。
   */

  const payload = {

    agent_id:
      RAGFLOW_AGENT_ID,


    /*
     * query 永远保留。
     *
     * 保证：
     *
     * sys.query
     * 当前用户消息
     * 聊天上下文
     *
     * 正常更新。
     */

    query:
      message,


    stream:
      false
  };



  /*
   * 多轮会话。
   */

  if (sessionId) {

    payload.session_id =
      sessionId;
  }



  /*
   * =====================================================
   * 关键修复：
   *
   * 恢复 RAGFlow UserFillUp
   * =====================================================
   *
   * 如果上一轮：
   *
   * event = user_inputs
   *
   * 那么当前 session
   * 停在 UserFillUp。
   *
   *
   * 下一轮不能只发送：
   *
   * query
   *
   *
   * 必须同时发送：
   *
   * inputs
   *
   *
   * 例如：
   *
   * {
   *   query:
   *     "3台JRB-800EV，四川眉山",
   *
   *   inputs: {
   *     additional_info:
   *       "3台JRB-800EV，四川眉山"
   *   }
   * }
   */

  if (sessionId) {

    const pending =
      pendingUserInputs.get(
        sessionId
      );



    /*
     * 当前 Agent 正常情况下：
     *
     * 一个 UserFillUp
     * 一次等待一个自由文本字段。
     */

    if (
      pending &&

      Array.isArray(
        pending.inputKeys
      ) &&

      pending.inputKeys.length ===
        1
    ) {

      const inputKey =
        pending.inputKeys[0];



      payload.inputs = {

        [inputKey]:
          message
      };



      console.log(

        new Date()
          .toISOString(),


        'RESUME_USER_INPUT',


        sessionId,


        inputKey
      );
    }



    /*
     * 如果未来一个 Wait Input
     * 同时出现多个独立字段，
     *
     * 不把同一句话盲目复制给所有字段。
     */

    else if (
      pending &&

      Array.isArray(
        pending.inputKeys
      ) &&

      pending.inputKeys.length >
        1
    ) {

      console.warn(

        'MULTIPLE_USER_INPUT_FIELDS',

        JSON.stringify(
          {

            sessionId,


            inputKeys:
              pending.inputKeys
          }
        )
      );
    }
  }



  /*
   * =====================================================
   * 请求 RAGFlow
   * =====================================================
   */

  const response =
    await fetch(

      `${RAGFLOW_BASE_URL}/api/v1/agents/chat/completions`,

      {

        method:
          'POST',



        headers: {

          Authorization:
            `Bearer ${RAGFLOW_API_KEY}`,


          'Content-Type':
            'application/json; charset=utf-8'
        },



        body:
          JSON.stringify(
            payload
          ),



        signal:
          AbortSignal.timeout(
            RAGFLOW_TIMEOUT_MS
          )
      }
    );



  /*
   * HTTP 错误。
   */

  if (
    !response.ok
  ) {

    throw new Error(
      `RAGFLOW_HTTP_${response.status}`
    );
  }



  /*
   * 读取 RAGFlow JSON。
   */

  const result =
    await response.json();



  /*
   * RAGFlow 业务错误。
   */

  if (
    result.code !== 0
  ) {

    throw new Error(
      `RAGFLOW_CODE_${result.code}`
    );
  }



  /*
   * 当前事件。
   */

  const event =
    result?.data?.event ||
    '';



  /*
   * 当前事件数据。
   */

  const nodeData =
    result?.data?.data ||
    {};



  /*
   * RAGFlow 返回 sessionId。
   */

  const returnedSessionId =
    result?.data?.session_id;



  /*
   * 本轮真正使用的 sessionId。
   */

  const activeSessionId =

    returnedSessionId ||

    sessionId ||

    null;



  /*
   * =====================================================
   * event = user_inputs
   * =====================================================
   *
   * 这不是错误。
   *
   * 表示 RAGFlow：
   *
   * 正在等待用户填写
   * UserFillUp。
   */

  if (
    event ===
    'user_inputs'
  ) {

    /*
     * 记录本次需要填写的字段。
     */

    const inputKeys =
      rememberPendingInputs(

        activeSessionId,

        nodeData
      );



    console.log(

      new Date()
        .toISOString(),


      'WAITING_USER_INPUT',


      activeSessionId,


      JSON.stringify(
        inputKeys
      )
    );



    /*
     * 获取 RAGFlow 对客户显示的提示。
     *
     * user_inputs 常见结构：
     *
     * data.inputs
     * data.tips
     */

    const prompt =

      extractText(
        nodeData.content
      ) ||

      extractText(
        nodeData.tips
      ) ||

      '为了继续处理您的需求，请补充相关信息。';



    return {

      content:
        prompt,


      sessionId:
        activeSessionId,


      event:
        'user_inputs',


      waitingForInput:
        true,


      /*
       * 这里只返回字段名。
       *
       * 不返回完整内部 schema。
       */

      inputKeys
    };
  }



  /*
   * =====================================================
   * workflow_finished / 正常回答
   * =====================================================
   */

  const content =

    /*
     * API 包装层可能直接提供 content。
     */

    extractText(
      nodeData.content
    ) ||


    /*
     * outputs 可能是：
     *
     * {
     *   content: "..."
     * }
     */

    extractText(
      nodeData.outputs?.content
    ) ||


    /*
     * outputs 也可能本身就是字符串。
     */

    extractText(
      nodeData.outputs
    ) ||


    extractText(
      result?.data?.content
    ) ||


    extractText(
      result?.content
    );



  /*
   * 真正异常：
   *
   * 不是 user_inputs，
   * 也没有任何可展示结果。
   */

  if (!content) {

    console.warn(

      'EMPTY_RAGFLOW_CONTENT_DETAILS',

      JSON.stringify(
        {

          code:
            result?.code,


          event,


          sessionId:
            activeSessionId,


          dataKeys:
            Object.keys(
              nodeData
            ),


          outputKeys:

            nodeData.outputs &&
            typeof nodeData.outputs ===
              'object'

              ? Object.keys(
                  nodeData.outputs
                )

              : []
        }
      )
    );


    throw new Error(
      'EMPTY_RAGFLOW_CONTENT'
    );
  }



  /*
   * 工作流已经正常继续，
   *
   * 不再处于当前 UserFillUp
   * 等待状态。
   */

  clearPendingInputs(
    activeSessionId
  );



  return {

    content,


    sessionId:
      activeSessionId,


    event:
      event ||
      'workflow_finished',


    waitingForInput:
      false,


    inputKeys:
      []
  };
}



/*
 * =======================================================
 * HTTP Server
 * =======================================================
 */

const server =
  http.createServer(

    async (
      req,
      res
    ) => {



      /*
       * ===================================================
       * OPTIONS
       * ===================================================
       */

      if (
        req.method ===
        'OPTIONS'
      ) {

        res.writeHead(
          204,
          {

            'Access-Control-Allow-Origin':
              '*',


            'Access-Control-Allow-Headers':
              'Content-Type',


            'Access-Control-Allow-Methods':
              'GET,POST,OPTIONS',


            'Cache-Control':
              'no-store'
          }
        );


        res.end();


        return;
      }



      /*
       * ===================================================
       * GET /health
       * ===================================================
       *
       * 不消耗限流额度。
       */

      if (
        req.method ===
          'GET' &&

        req.url ===
          '/health'
      ) {

        sendJson(
          res,
          200,
          {

            ok:
              true,


            service:
              'huayuejiang-miniapp-gateway'
          }
        );


        return;
      }



      /*
       * ===================================================
       * 只允许 POST /chat
       * ===================================================
       */

      if (
        req.method !==
          'POST' ||

        req.url !==
          '/chat'
      ) {

        sendJson(
          res,
          404,
          {

            ok:
              false,


            error:
              'NOT_FOUND'
          }
        );


        return;
      }



      /*
       * ===================================================
       * 客户端 IP
       * ===================================================
       */

      const clientIp =
        getClientIp(
          req
        );



      /*
       * ===================================================
       * 请求频率限流
       * ===================================================
       */

      const rateResult =
        checkRateLimit(
          clientIp
        );



      if (
        !rateResult.allowed
      ) {

        console.warn(

          new Date()
            .toISOString(),


          'RATE_LIMIT',


          clientIp
        );



        sendJson(
          res,
          429,
          {

            ok:
              false,


            error:
              'RATE_LIMITED',


            message:
              '请求过于频繁，请稍后再试。',


            retryAfter:
              rateResult
                .retryAfterSeconds
          },
          {

            'Retry-After':
              String(
                rateResult
                  .retryAfterSeconds
              )
          }
        );


        return;
      }



      /*
       * ===================================================
       * 并发限制
       * ===================================================
       */

      if (
        !acquireConcurrentSlot(
          clientIp
        )
      ) {

        console.warn(

          new Date()
            .toISOString(),


          'TOO_MANY_CONCURRENT_REQUESTS',


          clientIp
        );



        sendJson(
          res,
          429,
          {

            ok:
              false,


            error:
              'TOO_MANY_CONCURRENT_REQUESTS',


            message:
              '当前请求正在处理中，请稍后再试。'
          }
        );


        return;
      }



      try {

        /*
         * =================================================
         * 读取请求 Body
         * =================================================
         */

        const body =
          await readJsonBody(
            req
          );



        const message =

          typeof body.message ===
            'string'

            ? body.message
                .trim()

            : '';



        const sessionId =

          typeof body.sessionId ===
            'string'

            ? body.sessionId
                .trim()

            : '';



        /*
         * =================================================
         * 空消息
         * =================================================
         */

        if (!message) {

          sendJson(
            res,
            400,
            {

              ok:
                false,


              error:
                'MESSAGE_REQUIRED',


              message:
                '请输入要咨询的问题。'
            }
          );


          return;
        }



        /*
         * =================================================
         * 单次消息长度限制
         * =================================================
         */

        if (
          message.length >
          2000
        ) {

          sendJson(
            res,
            400,
            {

              ok:
                false,


              error:
                'MESSAGE_TOO_LONG',


              message:
                '单次消息过长，请精简后重试。'
            }
          );


          return;
        }



        /*
         * =================================================
         * 调用 RAGFlow
         * =================================================
         */

        const result =
          await callRagflow(

            message,

            sessionId ||
              null
          );



        /*
         * =================================================
         * 成功返回
         * =================================================
         */

        sendJson(
          res,
          200,
          {

            ok:
              true,


            content:
              result.content,


            sessionId:
              result.sessionId,


            event:
              result.event,


            waitingForInput:
              result
                .waitingForInput,


            /*
             * Debug / 状态字段。
             *
             * 只包含字段名，
             * 不包含内部 schema。
             */

            inputKeys:
              result.inputKeys ||
              [],


            rateLimit: {

              remaining:
                rateResult
                  .remaining
            }
          }
        );


      } catch (error) {

        const code =
          error?.message ||
          'UNKNOWN_ERROR';



        /*
         * =================================================
         * 非法 JSON
         * =================================================
         */

        if (
          code ===
          'INVALID_JSON'
        ) {

          sendJson(
            res,
            400,
            {

              ok:
                false,


              error:
                'INVALID_JSON',


              message:
                '请求格式不正确。'
            }
          );


          return;
        }



        /*
         * =================================================
         * 请求体过大
         * =================================================
         */

        if (
          code ===
          'REQUEST_TOO_LARGE'
        ) {

          sendJson(
            res,
            413,
            {

              ok:
                false,


              error:
                'REQUEST_TOO_LARGE',


              message:
                '请求内容过大。'
            }
          );


          return;
        }



        /*
         * =================================================
         * 服务端日志
         * =================================================
         *
         * 不打印：
         *
         * API Key
         * 知识库完整内容
         * structured
         * reference
         */

        console.error(

          new Date()
            .toISOString(),


          clientIp,


          code
        );



        /*
         * =================================================
         * 对客户端统一隐藏内部错误
         * =================================================
         */

        sendJson(
          res,
          500,
          {

            ok:
              false,


            error:
              'AI_SERVICE_ERROR',


            message:
              '智能客服暂时无法响应，请稍后重试。'
          }
        );


      } finally {

        /*
         * 无论成功失败，
         * 都释放当前 IP 并发槽。
         */

        releaseConcurrentSlot(
          clientIp
        );
      }
    }
  );



/*
 * =======================================================
 * 启动 Gateway
 * =======================================================
 *
 * 只监听本机：
 *
 * 127.0.0.1:8787
 *
 *
 * 公网访问：
 *
 * 手机
 * ↓
 * HTTPS
 * ↓
 * Cloudflare
 * ↓
 * cloudflared
 * ↓
 * 127.0.0.1:8787
 * ↓
 * Gateway
 * ↓
 * RAGFlow
 *
 *
 * 这样 8787 不直接暴露到局域网或公网。
 */

server.listen(

  PORT,

  '127.0.0.1',

  () => {


    console.log(

      `Huayuejiang miniapp gateway listening on port ${PORT}`

    );



    console.log(

      `Rate limit: ${RATE_LIMIT_MAX_REQUESTS} requests / ${RATE_LIMIT_WINDOW_MS} ms / IP`

    );



    console.log(

      `Concurrent limit: ${MAX_CONCURRENT_PER_IP} requests / IP`

    );



    console.log(

      `RAGFlow timeout: ${RAGFLOW_TIMEOUT_MS} ms`

    );

  }
);