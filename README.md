# Implante Flow API

API clínica do prontuário [Implante Flow](https://github.com/Orthoflow-Resende/Implate-flow). Este repositório é o backend Node.js/Fastify. O aplicativo Flutter e a infraestrutura de deploy ficam em repositórios separados.

## Imagem no GitHub Container Registry

A imagem de produção fica em [ghcr.io/orthoflow-tecnologia/implante-flow-api](https://github.com/Orthoflow-Tecnologia/implante-flow-api/pkgs/container/implante-flow-api), vinculada a este repositório. Tags: `latest` e `0.2.1` (multi-arch `linux/amd64` e `linux/arm64`).

O pacote é **privado**: quem puxa a imagem precisa de acesso ao repositório (ou permissão explícita no pacote) e de um token com escopo `read:packages`.

```bash
# autenticação (PAT classic com read:packages, ou token do gh)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin

docker pull ghcr.io/orthoflow-tecnologia/implante-flow-api:latest
```

Copie as variáveis abaixo para um `.env` (em staging/production `DATABASE_URL` e WorkOS são obrigatórios):

```env
APP_ENV=production
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info
OPENAPI_ENABLED=false
WORKOS_ISSUER=https://api.workos.com/user_management/<client_id>
WORKOS_AUDIENCE=<client_id>
WORKOS_JWKS_URL=https://api.workos.com/sso/jwks/<client_id>
DATABASE_URL=postgres://user:pass@host:5432/implante_flow
S3_BUCKET=implante-flow
S3_REGION=sa-east-1
S3_ENDPOINT=
S3_PUBLIC_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
CORS_ORIGINS=
```

```bash
docker run --rm -p 3000:3000 --env-file .env \
  ghcr.io/orthoflow-tecnologia/implante-flow-api:latest
```

Em Compose, troque o `build: .` do serviço `api` por:

```yaml
image: ghcr.io/orthoflow-tecnologia/implante-flow-api:latest
```

A imagem escuta em `0.0.0.0:3000`, roda sem privilégio e já define healthcheck em `GET /health`. Segredos não entram na imagem: passe tudo por ambiente. Migrations em `migrations/` rodam na subida do processo.

## Executar em desenvolvimento

Requer Node.js 24.

```bash
docker compose up -d --build
```

`docker compose up -d --build` sobe PostgreSQL, MinIO e a API (build local), para desenvolvimento. WorkOS (`WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_JWKS_URL`) pode ir num `.env` ao lado do compose; o restante da API já vem do `compose.yaml`. Staging e production não usam este arquivo: lá `DATABASE_URL` e `S3_*` vêm do ambiente de execução.

Para hot reload no host, use `npm install` e `npm run dev` com Postgres e MinIO do compose; nesse caso não suba o serviço `api` (`docker compose up -d postgres minio minio-setup`).

A API escuta em `http://127.0.0.1:3000`.

```bash
npm test
npm run typecheck
npm run build
npm start
```

Variáveis em [`.env.example`](.env.example). O processo lê o ambiente; não há arquivo `.env` carregado automaticamente.

## Contrato de execução

Este contrato é o que a infraestrutura ([F3S-466](https://linear.app/felpszip/issue/F3S-466/infra-ambientes-cicd-e-deploy-da-api-clinica)) deve usar para publicar o processo. Provisionamento, DNS, TLS, segredos e pipeline ficam fora deste repositório.

| Probe | Uso | Sucesso | Falha |
| --- | --- | --- | --- |
| `GET /health` | Liveness do processo | `200 {"status":"ok"}` | processo sem resposta |
| `GET /ready` | Readiness das dependências | `200 {"status":"ready"}` | `503 {"status":"unavailable"}` |

Os dois probes são públicos, não versionados e não consultam dado clínico. Não exigem `Authorization`. O orquestrador deve usar `/health` para reiniciar o processo e `/ready` para tirar a instância do balanceador.

`GET /v1` identifica o serviço. Rotas em `/v1` exigem `Authorization: Bearer` com access token do WorkOS (issuer, audience, expiração e JWKS). O `sub` vira o dentista dono. Probes e `/docs` continuam públicos. Mudança incompatível de contrato abre `/v2`.

Cabeçalho `x-request-id` é devolvido em toda resposta. Se o valor recebido tiver entre 1 e 128 caracteres seguros (`A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`), ele é preservado. Caso contrário, a API gera um UUID.

Erro de cliente:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Requisição inválida.",
    "requestId": "req-123"
  }
}
```

Falha interna responde `500` com `code: "internal_error"` e a mensagem fixa `Erro interno.`. Log é JSON no stdout. `Authorization` e `Cookie` são removidos do log. O log não recebe nome de paciente, lote, foto nem corpo clínico.

OpenAPI: `GET /docs/json` e interface em `GET /docs`. Ficam desligados quando `APP_ENV=production`, a menos que `OPENAPI_ENABLED=true`.

A imagem `Dockerfile` escuta em `0.0.0.0:3000`, roda com usuário sem privilégio e já define o healthcheck em `/health`. `APP_ENV` e `PORT` devem ser injetados pelo ambiente. Segredo não entra na imagem nem no repositório.

| Variável | Default | Valores |
| --- | --- | --- |
| `APP_ENV` | `development` | `development`, `staging`, `production`, `test` |
| `HOST` | `0.0.0.0` | endereço de bind |
| `PORT` | `3000` | `1`–`65535` |
| `LOG_LEVEL` | `info` (`silent` em `test`) | níveis do Pino |
| `OPENAPI_ENABLED` | `true` fora de `production` | `true`, `false` |
| `CORS_ORIGINS` | vazio | origens separadas por vírgula |
| `DATABASE_URL` | vazio | obrigatório em `staging` e `production` |
| `S3_BUCKET` | vazio | nome do bucket; sem ele, fotos e certificados ficam indisponíveis |
| `S3_REGION` | `sa-east-1` | região do bucket |
| `S3_ENDPOINT` | vazio | URL http(s) do S3 local; vazio usa o endpoint da nuvem |
| `S3_PUBLIC_ENDPOINT` | vazio | URL do S3 vista pelo cliente (URLs assinadas); só com endpoint local |
| `S3_ACCESS_KEY_ID` | vazio | junto com endpoint e segredo; vazio usa a credencial do ambiente |
| `S3_SECRET_ACCESS_KEY` | vazio | junto com endpoint e access key |

O processo aplica as migrations SQL de `migrations/` ao iniciar. `npm run migrate` faz o mesmo passo sem subir o HTTP. Consultas clínicas entram com `SET LOCAL ROLE implante_app` e `app.dentist_id`, sob row level security. O papel da aplicação não contorna essa política. `/ready` consulta o banco quando `DATABASE_URL` existe.

`SIGTERM` e `SIGINT` fecham o servidor antes do processo sair.
