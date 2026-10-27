const CONFIG = require('../../utils/config')

Page({
  data: {
    inputText: '',
    sending: false,
    sessionId: '',
    scrollIntoView: 'msg-welcome',

    messages: [
      {
        id: 'msg-welcome',
        role: 'assistant',
        text: '您好，我是华越疆智能客服。您可以咨询产品、应用场景、技术方案、采购及售后问题。'
      }
    ]
  },

  onLoad() {
    // 本地测试阶段：
    // 如果之前已经有同一段聊天会话，则继续使用。
    const savedSessionId = wx.getStorageSync('hyj_ragflow_session_id')

    if (savedSessionId) {
      this.setData({
        sessionId: savedSessionId
      })
    }
  },

  startNewSession() {
    wx.removeStorageSync('hyj_ragflow_session_id')
  
    this.setData({
      sessionId: '',
      inputText: '',
      sending: false,
      scrollIntoView: 'msg-welcome',
  
      messages: [
        {
          id: 'msg-welcome',
          role: 'assistant',
          text: '您好，我是华越疆智能客服。您可以咨询产品、应用场景、技术方案、采购及售后问题。'
        }
      ]
    })
  
    wx.showToast({
      title: '已新建会话',
      icon: 'success',
      duration: 1200
    })
  },

  onInput(e) {
    this.setData({
      inputText: e.detail.value
    })
  },

  sendMessage() {
    const text = (this.data.inputText || '').trim()

    if (!text || this.data.sending) {
      return
    }

    const now = Date.now()

    const userMessage = {
      id: `msg-user-${now}`,
      role: 'user',
      text
    }

    const newMessages = this.data.messages.concat(userMessage)

    this.setData({
      messages: newMessages,
      inputText: '',
      sending: true,
      scrollIntoView: userMessage.id
    })

    const requestData = {
      message: text
    }

    // 有 sessionId 时回传给 Gateway，
    // 保证“它 / 这款 / 那个型号”等多轮指代连续。
    if (this.data.sessionId) {
      requestData.sessionId = this.data.sessionId
    }

    wx.request({
      url: `${CONFIG.GATEWAY_BASE_URL}/chat`,
      method: 'POST',

      header: {
        'Content-Type': 'application/json'
      },

      data: requestData,

     timeout: CONFIG.REQUEST_TIMEOUT,

      success: (res) => {
        console.log('Gateway response:', res)

      // 请求过于频繁
if (
  res.statusCode === 429 &&
  res.data &&
  res.data.error === 'RATE_LIMITED'
) {
  const retryAfter =
    Number(res.data.retryAfter || 0)

  let text =
    '您发送得有点快，请稍等片刻再试。'

  if (retryAfter > 0) {
    text =
      `您发送得有点快，请约 ${retryAfter} 秒后再试。`
  }

  this.appendErrorMessage(text)
  return
}


// 同时请求过多
if (
  res.statusCode === 429 &&
  res.data &&
  res.data.error ===
    'TOO_MANY_CONCURRENT_REQUESTS'
) {
  this.appendErrorMessage(
    '上一条问题还在处理中，请稍等一下再试。'
  )
  return
}


// 其他服务错误
if (
  res.statusCode !== 200 ||
  !res.data ||
  res.data.ok !== true
) {
  this.appendErrorMessage(
    '智能客服暂时无法响应，请稍后重试。'
  )
  return
}

        const content =
          (res.data.content || '').trim()

        const returnedSessionId =
          (res.data.sessionId || '').trim()

        if (returnedSessionId) {
          this.setData({
            sessionId: returnedSessionId
          })

          wx.setStorageSync(
            'hyj_ragflow_session_id',
            returnedSessionId
          )
        }

        if (!content) {
          this.appendErrorMessage(
            '智能客服暂时没有返回有效内容，请稍后重试。'
          )
          return
        }

        const assistantMessage = {
          id: `msg-assistant-${Date.now()}`,
          role: 'assistant',
          text: content
        }

        this.setData({
          messages: this.data.messages.concat(
            assistantMessage
          ),
          sending: false,
          scrollIntoView: assistantMessage.id
        })
      },

      fail: (err) => {
        console.error('Gateway request failed:', err)

        this.appendErrorMessage(
          '暂时无法连接智能客服，请确认本地服务已启动后重试。'
        )
      }
    })
  },

  appendErrorMessage(text) {
    const errorMessage = {
      id: `msg-error-${Date.now()}`,
      role: 'assistant',
      text
    }

    this.setData({
      messages: this.data.messages.concat(
        errorMessage
      ),
      sending: false,
      scrollIntoView: errorMessage.id
    })
  }
})