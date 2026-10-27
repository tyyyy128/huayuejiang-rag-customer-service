# Huayuejiang RAG AI Customer Service

Source-only snapshot for the local RAGFlow customer-service system.

## Structure
- `ragflow-custom/agent/canvas.py`: locally customized RAGFlow v0.27.2 runtime component.
- `gateway/`: Node.js HTTP gateway to RAGFlow.
- `miniapp/`: WeChat mini-program application.
- `launcher/`: local Windows one-click startup scripts.
- `workflows/`: place a reviewed RAGFlow Agent Canvas export here manually.

## Important
- Upstream RAGFlow: https://github.com/infiniflow/ragflow (Apache-2.0).
- This repository does not contain the whole RAGFlow upstream project.
- Never commit API keys, tokens, .env files, real customer chats, Docker volumes,
  or company knowledge-base documents without explicit authorization.
- The Agent Canvas and dataset configuration may live in RAGFlow storage,
  not in the `canvas.py` file. Export the workflow separately.
- A source backup is not a deployable or complete database backup.