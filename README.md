# JPXFORGE

Equipe de IA para desenvolvimento da jpxlab. O WORK administra pedidos e aprovações; o Forge transforma briefings em software e devolve evidências para revisão.

## Começar no Windows

Requisito: **Node.js 24 LTS** e Git. Este checkout foi verificado com Node 24.19.0 no Windows. Na primeira utilização:

```powershell
cd C:\Users\joaop\jpxforge
npm ci
npm run demo
```

Ou abra `INICIAR-FORGE.cmd`. A demonstração não pede chave: usa respostas simuladas identificadas, gera arquivos reais, executa build/testes e cria um commit local. O resultado informa a pasta da página. Dados de demonstração ficam em `.forge-demo/`, separados da operação real; não são enviados ao GitHub. O modo demo valida o encadeamento, não a qualidade de um modelo real.

Para acompanhar pela tela, execute **npm run studio** ou abra **ABRIR-PAINEL.cmd**, mantenha o terminal aberto e acesse **http://127.0.0.1:4100**. O painel mostra o escritório isométrico, seis integrantes, projetos, tarefas, conversa da equipe e prévia. O modo demonstração usa sempre o exemplo fixo do Estúdio Aurora, como informado na tela.

Para configurar os provedores reais:

```powershell
npm run setup
npm run doctor
npm start
```

O setup solicita a chave DeepSeek em campo oculto. Ela fica em `jpxforge.config.json`, ignorado pelo Git. O doctor consulta a disponibilidade sem gerar texto. A configuração deve permanecer em uma pasta privada do usuário; no Windows a proteção efetiva depende da ACL da pasta. Sem chave válida, use a demonstração.

## Piloto reproduzível com DeepSeek

Para conferir o fluxo sem consumir API:

```powershell
npm run pilot -- --offline
```

Para validar um modelo real depois de configurar a chave pelo setup:

```powershell
npm run pilot -- --live --model deepseek-v4-flash
```

**`--live` faz chamadas pagas.** Sem essa opção o piloto usa fixtures. A chave também pode vir de `DEEPSEEK_API_KEY`; não a coloque no comando nem no relatório. O piloto usa somente essa chave, o endpoint oficial DeepSeek e o modelo informado para Nina, Atlas e Juno. As rotas da operação normal permanecem como estavam. O parâmetro `thinking` fica desativado neste piloto para reservar a saída ao JSON. Confirme o modelo disponível na sua conta antes da execução; a documentação atual lista [os modelos DeepSeek](https://api-docs.deepseek.com/) e [o controle de thinking](https://api-docs.deepseek.com/guides/thinking_mode/).

Cada execução usa briefing fictício do Estúdio Aurora, cria um banco e workspace novos em `.forge-pilots/` e salva `pilot-report.json` antes das chamadas e ao concluir cada etapa. Não lê a fila operacional, não conecta ao WORK, não faz push e não retoma uma tentativa anterior. A pasta é ignorada pelo Git. O resultado mostra o caminho da prévia para revisão humana.

O máximo é de **três chamadas**, sem fallback nem repetição automática. `--max-calls 1` ou `2` reduz esse limite; `--timeout-ms` aceita 100 a 300000 ms por chamada, com padrão de 60000. Cada chamada pede no máximo 8000 tokens de saída. Ao falhar ou cancelar, o piloto preserva a evidência em quarentena e termina com código diferente de zero. Um relatório ainda em `running` indica execução incompleta e exige inspeção. Uma nova execução paga é sempre uma nova tentativa.

O relatório contém duração, tarefas, tokens informados, uso de cache quando disponível, categorias de falha, HTTP status, QA e commit local. O aceite real exige as cinco tarefas concluídas e métricas de todas as chamadas; revisão visual/comercial permanece pendente. Resposta sem métricas ou erro de rede tem uso desconhecido. Tokens de respostas truncadas continuam registrados.

Para estimar USD, informe `--pricing caminho.json` com tarifas conferidas por você. Nenhum preço é embutido. O JSON deve conter os campos abaixo:

| Campo | Valor |
| --- | --- |
| `currency` | `"USD"` |
| `model` | O mesmo identificador passado a `--model` |
| `input_usd_per_million` | Número: USD por milhão de tokens de entrada sem cache |
| `cached_input_usd_per_million` | Número opcional: USD por milhão de tokens em cache |
| `output_usd_per_million` | Número: USD por milhão de tokens de saída |
| `checked_on` | Data em `AAAA-MM-DD` da conferência das tarifas |

Sem tarifa, `estimated_usd` é `null`. Quando faltam contadores de alguma chamada, a estimativa total também é `null`, e o subtotal conhecido fica separado. Sem detalhamento de cache, a estimativa usa a tarifa de entrada sem cache e informa esse método. Isso é estimativa das chamadas deste piloto, não fatura ou orçamento monetário global; o bloqueio de gastos da operação continua no backlog.

Verificação local desta etapa: Node 24.19.0, build e **58 testes aprovados**. Os testes de API DeepSeek usam servidor HTTP local simulado; o aceite com a chave real continua pendente. Comandos finitos usam `node --import tsx` para não depender do pipe interno do CLI `tsx`; `npm run dev` mantém o watch anterior.

## Fluxo implementado

Nina transforma o briefing em spec validada; Atlas propõe três tarefas ordenadas; Juno gera HTML/CSS estáticos; Vera executa build e testes de um template confiável; a entrega cria commit Git. O pipeline restringe arquivos e conteúdo, não instala dependências nem executa comandos produzidos pelo modelo.

Serviço inicial: **landing page estática**. Scripts, formulários ativos, imagens externas e serviços backend precisam de templates e isolamento adicionais. Conteúdo, identidade visual e critérios comerciais continuam sujeitos a revisão. Sem destino de publicação a entrega fica em `review`; `shipped` significa push confirmado, não deploy nem aceite do cliente.

Publicação não ocorre por padrão. No painel real, após revisar o resultado, use **Enviar ao repositório** e informe URL HTTPS e branch de desenvolvimento de um repositório existente. O Git local precisa ter acesso. A API `POST /projects/:id/publish` cria uma nova tarefa de envio; solicitações repetidas enquanto há envio pendente são rejeitadas. A demonstração bloqueia essa operação. `github.token` e `auto_create_repo` sozinhos não publicam. A interface interna `runNextTask(router, { publish: { remote, branch } })` continua disponível para testes/integrações. Os testes usam repositório bare temporário local.

## Comandos e API

```powershell
npm run build
npm run typecheck
npm test
npm run check
```

O pacote compartilhado é compilado antes dos comandos que o importam. `npm run dev` executa em modo de desenvolvimento. `FORGE_DATA_DIR` seleciona uma pasta de dados isolada; caminhos não dependem da pasta onde o comando foi chamado.

Servidor padrão: `http://127.0.0.1:4100`. Enviar um briefing com o servidor real ativo:

```powershell
$briefing = @{ source = 'manual'; raw_text = 'Crie uma landing page estática para um estúdio de design, com serviços e contato.' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:4100/briefings -Method Post -ContentType 'application/json' -Body $briefing
```

| Rota | Finalidade |
| --- | --- |
| POST `/briefings` | Criar projeto e tarefa inicial de forma atômica |
| GET `/briefings/:id` | Projeto, tarefas, resultados e tokens |
| GET `/projects` | Últimos projetos |
| POST `/projects/:id/abort` | Interromper trabalho e impedir conclusão tardia |
| POST `/projects/:id/publish` | Solicitar envio explícito de uma entrega pronta ao repositório |
| GET `/` | Escritório, projetos, tarefas e conversa |
| GET `/preview/:id/index.html` | Prévia restrita após QA aprovado |
| GET `/events?limit=100` | Histórico limitado entre 1 e 500 eventos |
| WS `/events/live` | Eventos persistidos transmitidos ao vivo |
| GET `/health` | Processo ativo, modo e provedores configurados; não certifica conexão externa |

Servidor somente local, com verificação de origem e hostname. Não exponha esta API na internet: autenticação remota ainda não foi implementada. Tarefas interrompidas por crash entram em quarentena para inspeção de possíveis efeitos já executados. O projeto ainda não possui uma tela para retomar quarentena.

## WORK e roadmap

Contrato v1 preservado. Cliente HTTP e outbox persistente foram reforçados para sequências, ACK, conflitos, leases e novas tentativas. **Novas retiradas automáticas permanecem bloqueadas**, inclusive com `auto_claim: true`, até o piloto completo. Configurado com token e `auto_claim: false`, o poller pode drenar concessões antigas. Não teste com dados reais de clientes.

| Fase | Estado desta passagem |
| --- | --- |
| 0 - Fundação | Corrigida; consulte evidências finais no HANDOFF |
| 1 - Pipeline seca | Implementação/testes offline; DeepSeek e push GitHub de projeto real pendentes |
| 2 - Dashboard isométrico e chat | MVP local verificado no navegador; seis sprites, briefing, prévia, stream e reconexão; configurações visuais e chat livre pendentes |
| 3 - Segurança/quarentena/custos | Proteções básicas e tokens; sandbox, scanners, orçamento monetário e retomada pendentes |
| 4 - WORK ativo e templates | Adaptador reforçado; piloto integrado e outros serviços pendentes |

## Continuidade entre modelos

Leia [AGENTS.md](AGENTS.md), [HANDOFF](docs/HANDOFF.md) e a [fila única](docs/BACKLOG.md). Antes de terminar, cada modelo deve registrar o que fez, testes e próximos passos, gerar um novo PDF e instruir o seguinte a repetir o processo. Ao atingir **90% de uso**, o PDF vira prioridade.

```powershell
python -m pip install reportlab
python scripts/export_handoff.py
```

Documento portátil: `output/pdf/JPXFORGE-CONTINUIDADE.pdf`. É uma fotografia datada; confira sempre o checkout atual. Nenhum segredo deve aparecer no documento ou em um commit.
