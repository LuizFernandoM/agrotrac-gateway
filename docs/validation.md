# Validação isolada do Gateway — 17/11/2026

## Ambiente e comandos

Windows PowerShell, Node.js 22.14.0, npm 10.9.2, Docker cliente e servidor 29.9.3, Docker Compose v5.7.0. Imagens oficiais nginx:1.28.2-alpine e node:22.14.0-alpine. A dependência de teste ws está fixada em 8.18.3 pelo lockfile.

A execução usou npm.cmd install --ignore-scripts --no-audit --no-fund em test para gerar o lockfile, node --check em fixture.mjs e run.mjs e node agrotrac-gateway/test/run.mjs a partir da raiz AgroTrac. Para repetir, use npm ci --ignore-scripts --no-audit --no-fund e npm test em agrotrac-gateway/test.

O runner executou docker compose -p PROJETO -f compose.test.yaml up --build -d, ps, port, exec para nginx -V e nginx -t, logs e stop -t 10. O Nginx 1.28.2 anunciou --with-http_auth_request_module e nginx -t validou a configuração renderizada. O runner também confirmou rejeição de um valor inválido de upstream no entrypoint.

O comportamento de 2xx/401/403 do módulo orientou a checagem explícita de 204. As diretivas de encaminhamento de corpo, cabeçalhos e timeouts seguem a documentação oficial. [Nginx auth_request](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html) · [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

O teste preserva Upgrade e Connection explicitamente e publica a porta no loopback do host. [Nginx WebSocket](https://nginx.org/en/docs/http/websocket.html) · [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)

## Resultado

A execução final produziu status passed após o teardown, com RUN_EXIT=0. As chamadas HTTP e os upgrades 101 passaram pelo Nginx real. Os upstreams de todos os casos eram fixtures Node.

- HTTP preservou prefixo, query, corpo, correlação e status dos upstreams. A allowlist recusou host incorreto, método incompatível, encoding no caminho, barras duplicadas ou finais, segmentos ponto, namespace incorreto, health administrativo e rotas internas. Cabeçalhos forjados foram descartados e os metadados do verificador foram reescritos. Logs não continham as sentinelas de rota, query ou credenciais.
- Login aceitou 16 KiB e excedente retornou 413. A borda aceitou 64 KiB em Core e rejeitou excedente. O multipart preservou foto de 10 MiB validada por SHA-256, JSON de 64 KiB e número total de bytes. A fixture retornou 201/200/409 para criação, replay e conflito, 413 quando uma parte excedeu seu limite e 400 sem boundary. A borda devolveu 413 acima de 12 MiB. Cache-Control: no-store confirmado em login, snapshot e anexo.
- A fixture de sessão confirmou 401/403, cookie, Bearer, CSRF, Origin, expiração e logout. Dois clientes receberam upgrade com agrotrac.live.v1, snapshot, update e checkpoint sem polling REST. Ping/pong atravessou o proxy. O logout da fixture fechou o socket correspondente com 1008 e preservou o segundo socket.
- O Gateway devolveu 503 sanitizado para 503 do verificador, 200 inesperado, timeout e perda real de conectividade depois de parar o container da fixture. Os casos com falha de verificação não incrementaram o contador de mutações. Um upstream HTTP lento excedeu o prazo de leitura e a resposta em dois blocos confirmou ausência de buffering. Liveness permaneceu 200 com o container fixture parado e readiness retornou 503.

As duas primeiras execuções terminaram com 503 no multipart. O ajuste final alinhou o limite do location interno ao maior corpo externo, pois a checagem de location usa o Content-Length da requisição original. O subrequest continua sem corpo para o verificador. Os workers usam o usuário nginx da imagem para acessar o diretório temporário previsto no empacotamento. As duas execuções seguintes passaram.

## Recursos preservados

Cada projeto criou uma rede privada interna e uma rede edge, ambas com prefixo do projeto. Somente o Gateway publicou a porta indicada em 127.0.0.1 durante o teste. Todos os containers abaixo foram observados em Exited (0) e as redes e imagens foram preservadas.

| Projeto | Porta local | Gateway | Fixture | Resultado do runner |
|---|---:|---|---|---|
| agrotrac-gwtest-b47a752d | 63961 | f29a68180870 | 5ee87f97fa25 | Falhou no multipart |
| agrotrac-gwtest-7df3ce07 | 64007 | ccc1b4d0dbf4 | f8fe2cae34ef | Falhou no multipart |
| agrotrac-gwtest-6ce9a339 | 58391 | df5495a919a7 | d3fad9d4f4bb | Passou |
| agrotrac-gwtest-21a911e0 | 50230 | e09764e4a583 | 32e971534ef3 | Passou, suíte final |

Antes e depois, docker ps mostrou PostgreSQL, RabbitMQ e Redis existentes healthy. Os testes não conectaram a esses serviços nem usaram bancos, credenciais, portas ou volumes da infraestrutura existente.

## Aceite integrado pendente

Permanecem pendentes verificador real do Live e persistência Redis da sessão, semântica e concorrência do Core, multipart no Audit real, heartbeat e revogação efetiva do Live, configuração de TLS/WSS e Web, e sincronização por iPhone com acesso autorizado. A fixture de autenticação é exclusiva do Compose de teste. O perfil container do Live e os binds privados explícitos de Core/Audit dependem da revisão de integração. O TLS foi definido na configuração e exige teste com certificado e origem aprovados.

## Revisão dos dois P2 — 17/11/2026

- `nginx.conf.template` alinha todas as rotas com ID ao UUIDv4 minúsculo e à variante RFC usada por Core e Audit. `test/fixture.mjs` aplica o mesmo formato no verificador. `test/run.mjs` cobre GET de silos, windows e bookings, DELETE de bookings, PATCH de status e GET de romaneio. A matriz espera 404 na borda para maiúsculas, versões 1 e 5 e variantes inválidas. IDs válidos exigem autenticação e preservam caminho e query ao chegar ao upstream.
- `nginx.conf.template` devolve 429 local com `Retry-After: 1`, JSON sanitizado e `Cache-Control: no-store`. O 429 de upstream passa com seu próprio corpo e cabeçalho. O teste usa 24 requisições de login em paralelo apenas na fixture local e verifica um único cabeçalho nos 429 de borda e de upstream, além da ausência dele nos 401 da rajada. [Nginx error_page](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page) · [Nginx limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html#limit_req)

A primeira execução validou `nginx -t` e a matriz de UUID. O runner saiu com código 1 ao receber 403 no multipart porque o verificador da fixture capturava `sync` como ID. A correção restringiu o padrão do Audit à rota de romaneio.

| Projeto | Porta local | Gateway | Fixture | Resultado do runner |
|---|---:|---|---|---|
| agrotrac-gwtest-76948871 | 61553 | d9c138ee4fb8 | 495bc310d841 | Falhou no multipart, ambos Exited (0) |
| agrotrac-gwtest-f8658a45 | 51500 | 289fc7d606ca | 9ab18390b747 | Passed após teardown, runner exit 0 e ambos Exited (0) |

A execução final confirmou `nginx -t` no Nginx 1.28.2 e passou a suíte completa, incluindo regressões de auth fail-closed, URI e prefixo, WebSocket, upload multipart e streaming sem buffering. O projeto publicou apenas `127.0.0.1:51500` durante a execução. O runner parou os containers e preservou as redes `agrotrac-gwtest-f8658a45_private` e `agrotrac-gwtest-f8658a45_edge`. A autenticação exercitada foi a da fixture. O aceite com o verificador real do Live permanece pendente.
