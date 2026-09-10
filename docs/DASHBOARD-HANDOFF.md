# Passagem do dashboard - 2026-09-09

## Implementado nesta etapa

O Forge agora oferece um painel local em http://127.0.0.1:4100. A tela inclui escritório isométrico desenhado em Canvas, seis sprites (Nina, Atlas, Pixel, Rex, Juno e Vera), presença baseada nas tarefas do projeto selecionado, lista de projetos, briefing em janela, cinco etapas da execução, interrupção, tokens e conversa da equipe baseada nos eventos persistidos. O personagem trabalha quando sua tarefa está running. Pixel e Rex ficam disponíveis no template atual, que usa Juno para construção. Sento ainda pertence ao trabalho futuro de segurança; não há scanner funcional representado como concluído.

Arquivos: apps/orchestrator/public/index.html, dashboard.css, dashboard.js, office.js; src/dashboard.ts registra assets e prévia; src/server.ts conecta essas rotas. Nenhum framework ou pacote novo de UI foi adicionado. npm run studio e ABRIR-PAINEL.cmd abrem o modo demonstração no servidor. O comando imprime o endereço para abrir no navegador; manter o terminal aberto. npm run demo continua sendo o fluxo finito somente terminal. npm start usa a configuração real feita no setup.

Modo demonstração é destacado na interface e usa fixtures fixas do Estúdio Aurora, mesmo se o usuário escrever outro briefing. Gera arquivos e testes reais, com zero chamadas pagas. O painel normal mostra MODELOS REAIS e usa as rotas configuradas; esta etapa não validou DeepSeek porque não há chave no checkout.

## Evidência visual e funcional

Build e 43 testes passaram após a primeira integração visual (41 anteriores + 2 para assets/previews). Teste no navegador por agent-browser: abriu a tela, enviou um briefing pelo formulário, observou as cinco tarefas done e a liberação da prévia. A página gerada abriu corretamente e carregou o CSS sob política restritiva. Console e erros de página estavam vazios na execução normal.

Desktop inspecionado em output/dashboard-desktop.png. Mobile em output/dashboard-mobile.png: viewport 390 px, largura total 390 px, seis pessoas e cinco tarefas concluídas; nenhuma rolagem horizontal. Página gerada em output/landing-mobile.png também foi inspecionada. Os arquivos contêm somente dados sintéticos.

Reconexão verificada: o servidor de demonstração foi interrompido quando não havia tarefa ativa. O painel mudou para Reconectando. Após reiniciar o servidor, mudou para Conectado, recuperou cinco tarefas e oito mensagens do projeto. O histórico é limitado às últimas 500 entradas recuperadas do servidor, e o chat mostra até 100 mensagens do projeto selecionado. A mesclagem usa eventId para não duplicar eventos recebidos por replay e stream. Não há garantia de replay ilimitado ou cursor de eventos nesta versão.

## Entrega por projeto

O botão Enviar ao repositório só é oferecido fora do modo demonstração, depois do commit local e com todas as tarefas concluídas. Solicita URL HTTPS e branch de desenvolvimento. O envio é uma nova tarefa persistida; a fila a executa e somente depois de push confirmado o projeto muda para shipped. A API interna também admite bare local para testes. Não cria repositórios nem faz deploy. Auth Git depende das credenciais já configuradas no computador. O modo demonstração bloqueia solicitações de envio na API, além de ocultar o botão. Os testes desta função estão em test/publish-api.test.ts; consultar resultado final consolidado no HANDOFF.

## Limites e retomada

Servidor somente loopback, origem/hostname verificados, assets em lista fixa. Prévia exige QA done e estado review/shipped, limita arquivos a index.html/styles.css do build, rejeita links/redirecionamento de diretórios e usa CSP sandbox sem scripts. Não serve config, banco, manifesto ou diretório Git. Isso é proteção local para conteúdo estático; não substitui sandbox de serviços arbitrários.

A conversa é registro dos agentes, sem caixa para enviar perguntas livres ou trocar instruções durante a execução. Configuração de chaves ainda usa npm run setup; tela de configurações, filtros avançados, acessibilidade aprofundada, gerenciamento de quarentena, scanners e orçamento monetário continuam pendentes. Tokens exibidos não são valor em reais ou dólares.

## Protocolo obrigatório

O próximo modelo deve ler AGENTS.md, HANDOFF, BACKLOG e relatórios específicos, descrever o trabalho enquanto executa, atualizar a fila única e as evidências, priorizar PDF ao atingir 90% de uso e gerar um novo PDF antes de encerrar. Deve repetir esta obrigação no documento para o modelo seguinte. Scripts e dados reais nunca devem incluir chaves nos artefatos. O checkpoint Git e os testes atuais prevalecem sobre uma fotografia antiga.
