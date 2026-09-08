# JPXFORGE

Fábrica autônoma de software da **jpxlab**: um time de agentes de IA
(cada um com seu pixel art no dashboard) que recebe briefings de clientes,
planeja, constrói, testa e entrega — com custo mínimo por projeto.

## O time

| Agente | Papel | Modelo padrão |
|---|---|---|
| **Nina** | Product Owner (briefing → spec) | DeepSeek Chat |
| **Atlas** | Tech Lead (planejamento, tasks) | DeepSeek Reasoner — *pago, prioridade* |
| **Pixel** | Web Dev | DeepSeek Chat |
| **Rex** | Back Dev | DeepSeek Chat |
| **Juno** | Full-stack | DeepSeek Chat |
| **Vera** | QA | Ollama local + ferramentas determinísticas |
| **Sento** | Segurança | Ollama local + scanners |

## Quickstart

```bash
# 1. Requisito: Node.js 20+
npm install

# 2. Configuração interativa — cola sua key do DeepSeek quando pedir.
#    Nenhum código precisa ser aberto; a key fica em jpxforge.config.json
#    (gitignored, nunca sobe pro GitHub).
npm run setup

# 3. Diagnóstico
npm run doctor

# 4. Liga a fábrica
npm run dev
```

## Integração WORK (contrato v1)

O jpxforge é **cliente** da API local do WORK (`http://127.0.0.1:4310`).
O WORK administra (fila, aprovações de cliente, revisão do João);
o jpxforge coordena a IA e os devs.

```
WORK (fila de handoffs aprovados)
   │  POST /integrations/dev-team/claim   (workerId estável)
   ▼
jpxforge: Nina gera Spec → Atlas planeja → devs constroem → Vera/Sento validam
   │  POST /handoffs/{id}/events  (progress / completed / failed)
   ▼
WORK (revisão do João → aceite ou ajustes)
```

Garantias implementadas (`src/work-client.ts`, `src/work-poller.ts`, `src/executions.ts`):

- **Outbox persistente**: todo evento ao WORK é gravado antes do envio com
  `eventId`+`sequence`; perda de confirmação → reenvio idêntico (idempotente)
- **Lease de 30 min**: vencimento aborta a execução local e manda o projeto
  pra quarentena — trabalho incerto nunca volta pra fila sozinho
- **Revogação/cancelamento**: token revogado (401/403) interrompe novas ações
  e aborta a execução ativa
- **Tokens nunca** em logs, URLs, prompts ou artefatos; banco SQLite e config
  com permissão restrita (600)
- Uma execução ativa por `workerId`; slots paralelos usam IDs estáveis distintos

> **Fase 0:** o poller nasce com `auto_claim: false` — o jpxforge testa a
> conexão (`npm run doctor`) mas ainda **não retira trabalho**. A retirada
> automática liga na Fase 1, quando a pipeline de build existir de verdade.

## Testando (Fase 0)

Com `npm run dev` rodando:

```bash
curl -X POST http://127.0.0.1:4100/briefings \
  -H "Content-Type: application/json" \
  -d @examples/briefing-exemplo.json
```

Anote o `project_id` retornado e acompanhe:

```bash
curl http://127.0.0.1:4100/briefings/<project_id>
```

Você verá a Nina transformar o briefing cru em spec estruturada,
com tokens contabilizados em `tokens`.

## API local

| Rota | Descrição |
|---|---|
| `POST /briefings` | Recebe briefing direto (testes/manual) |
| `GET /briefings/:id` | Status do projeto + spec + tasks + tokens |
| `GET /projects` | Histórico de projetos |
| `POST /projects/:id/abort` | Kill switch |
| `GET /events` | Histórico de eventos (replay) |
| `WS /events/live` | Stream em tempo real pro dashboard |
| `GET /health` | Saúde dos providers |

## Roadmap

- [x] **Fase 0** — Fundação: contratos, fila SQLite, ModelRouter, Nina (PO), API local, setup wizard, **adaptador WORK v1** (claim/outbox/lease/revogação)
- [ ] **Fase 1** — Atlas planeja, Juno constrói landing page em workspace, QA roda build/testes, push pro GitHub, `auto_claim` ligado
- [ ] **Fase 2** — Dashboard: escritório isométrico pixel art, chat da equipe, tela de Settings (trocar keys pelo navegador)
- [ ] **Fase 3** — Vera + Sento com scanners, quarentena automática, medidor de custo em R$
- [ ] **Fase 4** — Integração ativa com o WORK, templates por tipo de serviço
