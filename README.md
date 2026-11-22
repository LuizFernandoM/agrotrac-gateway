# AgroTrac Gateway

Gateway Nginx para Core, Audit e Live. O contrato de rotas, autenticação e integração está em [docs/contracts.md](docs/contracts.md). As evidências da execução local estão em [docs/validation.md](docs/validation.md).

## Configuração

A imagem usa Nginx 1.28.2 Alpine. O entrypoint valida os valores antes de renderizar a configuração. O listener interno usa a porta 8080. Configure estas variáveis explicitamente.

| Variável | Valor |
|---|---|
| GATEWAY_MODE | local-http para teste em loopback, tls para TLS no Nginx |
| GATEWAY_HOST | Host autorizado, com porta explícita quando enviada pelos clientes |
| CORE_UPSTREAM | DNS privado do Core e porta, por exemplo agrotrac-core:3001 |
| LIVE_UPSTREAM | DNS privado do Live e porta, por exemplo agrotrac-live:3002 |
| AUDIT_UPSTREAM | DNS privado do Audit e porta, por exemplo agrotrac-audit:3003 |

Para TLS, provisionar fullchain.pem e privkey.pem em /run/agrotrac/tls, montados somente leitura. A configuração final de certificado, origem, bind e publicação passa pela coordenação. Nginx resolve os nomes de upstream ao carregar a configuração. Se um upstream for recriado e mudar de endereço, recarregar o Gateway após validar com nginx -t.

O Gateway encaminha o caminho e a query dos endpoints permitidos e valida sessões com GET /internal/auth/verify no Live. Os caminhos de verificação interna e as variantes não canônicas recebem 404 externamente. Somente o status 204 do verificador permite encaminhamento. A política de Origin, CSRF, papéis e revogação é responsabilidade do Live. Core e Audit recebem apenas os cabeçalhos operacionais explicitamente permitidos, sem identidade nem credenciais. Os logs de acesso registram apenas status, tamanho e tempo. As mensagens detalhadas de erro do Nginx ficam desabilitadas porque podem incluir a requisição original.

## Executar na homologação

Use Docker com Compose e siga o guia `agrotrac-infra/docs/homologacao-compose.md` no workspace com os repositórios irmãos. O Gateway usa DNS privado para Core, Audit e Live e serve o portal na mesma origem da API e do WebSocket.

## Validação local isolada

Execute em agrotrac-gateway/test com Node.js 22, npm, Docker e Compose.

    npm ci --ignore-scripts --no-audit --no-fund
    npm test

O runner cria um projeto Compose com nome próprio, publica uma porta efêmera em 127.0.0.1 e exercita HTTP e WebSocket com o Nginx real. As fixtures Node ocupam somente a rede privada e a ferramenta envia Host gateway.test. O runner registra os IDs, verifica nginx -V e nginx -t e para seus containers preservando os recursos. Se uma interrupção externa impedir o teardown, usar docker compose -f compose.test.yaml -p PROJETO stop com o nome emitido pelo runner, a partir do Gateway.

Os testes demonstram o comportamento do proxy com upstreams controlados. Consulte o relatório funcional da Infra para as evidências de autenticação real, WebSocket e sincronização no iPhone.
