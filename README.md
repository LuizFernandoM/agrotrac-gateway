# AgroTrac Gateway — API Gateway & Proxy Reverso

Componente de borda responsável por centralizar a porta de entrada única do ecossistema **AgroTrac**, em estrita conformidade com a especificação original (`acac36b6`).

---

## 1. Responsabilidades

- **Ponto Único de Entrada**: Recebe todas as requisições externas originadas do Portal Web e do Aplicativo Mobile.
- **Roteamento Inteligente**: Encaminha as chamadas HTTP/HTTPS para o microsserviço correspondente (Core A, Live B ou Audit C).
- **Suporte a WebSockets (WSS)**: Realiza o upgrade transparente de protocolo HTTP para WebSocket persistente direcionado ao Live B.
- **Isolamento de Infraestrutura**: Evita expor portas internas de microsserviços, Redis, RabbitMQ e bancos de dados para a rede externa.
- **Transparência de Domínio**: Não concentra regras de negócio do domínio (atua estritamente como camada de transporte e roteamento).

---

## 2. Ferramentas e Tecnologias

- **Servidor Web / Proxy Reverso**: Nginx (imagem Docker oficial `nginx:alpine`).
- **Configuração**: Arquivo `nginx.conf` declarativo com diretivas de proxy reverso e cabeçalhos de WebSocket (`Upgrade` e `Connection`).

---

## 3. Mapeamento de Rotas e Arquitetura

O Gateway recebe as requisições na porta pública e distribui internamente pela rede Docker (`agrotrac-network`):

| Rota Externa | Protocolo | Destino Interno | Microsserviço |
| :--- | :--- | :--- | :--- |
| `/v1/core/*` | HTTP / REST | `http://agrotrac-core:3001` | Core A (Silos, Janelas, Reservas) |
| `/v1/live/*` | HTTP / REST | `http://agrotrac-live:3002` | Live B (Autenticação e Sessões) |
| `/live` | WebSocket (WSS) | `http://agrotrac-live:3002/live` | Live B (Canal de Tempo Real) |
| `/v1/audit/*` | HTTP / REST | `http://agrotrac-audit:3003` | Audit C (Sync Pesagens, Histórico) |

```text
agrotrac-gateway/
├── nginx.conf                   # Configuração das rotas e buffers de proxy
├── Dockerfile                   # Build do contêiner Nginx
└── README.md
```

---

## 4. Conexões e Integrações

- **Porta Externa Exposta**: `8080` (HTTP) / `8443` (WSS/HTTPS local).
- **Comunicação Interna**: Conecta-se aos demais contêineres pela rede interna do Docker (`agrotrac-network`).
