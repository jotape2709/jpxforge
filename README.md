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
