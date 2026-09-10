import { SpecSchema, type Role } from "@jpxforge/shared";
import type { ChatMessage, ChatOptions, ChatResult } from "./model-router.js";

/** Deliberately synthetic: no API calls, billed tokens, or claims of real AI output. */
export class DemoRouter {
  async chat(role: Role, _messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    options.signal?.throwIfAborted();
    const responses: Partial<Record<Role, unknown>> = {
      product_owner: SpecSchema.parse({
        title: "Estúdio Aurora - demonstração", service_type: "landing_page",
        summary: "Página de demonstração para um estúdio de design fictício.",
        business: { client_name: "Estúdio Aurora", niche: "design", value_proposition: "Ideias que ganham forma", call_to_action: "Vamos conversar" },
        sections: ["Apresentação", "Serviços", "Contato"], requirements: ["Layout responsivo", "Navegação acessível", "Conteúdo estático"],
        brand: { colors: ["#152c31", "#b6ef89"], tone: "acolhedor" },
      }),
      tech_lead: { tasks: [
        { key: "build", title: "Construir landing page", kind: "build_landing", depends_on: [] },
        { key: "qa", title: "Verificar build e testes", kind: "qa_landing", depends_on: ["build"] },
        { key: "publish", title: "Preparar entrega Git", kind: "publish_landing", depends_on: ["qa"] },
      ] },
      fullstack_dev: {
        title: "Estúdio Aurora | Demonstração Forge",
        body: '<header><a href="#inicio">AURORA</a><nav><a href="#servicos">Serviços</a><a href="#contato">Contato</a></nav></header><main id="inicio"><section class="hero"><p class="eyebrow">ESTÚDIO CRIATIVO / DEMONSTRAÇÃO</p><h1>Boas ideias merecem ganhar forma.</h1><p>Design com propósito para marcas que querem se aproximar das pessoas.</p><a class="button" href="#contato">Vamos conversar</a></section><section id="servicos"><h2>Da primeira ideia à presença digital.</h2><div class="cards"><article><h3>Identidade</h3><p>Uma marca com personalidade e clareza.</p></article><article><h3>Experiência</h3><p>Páginas simples, acessíveis e feitas para pessoas.</p></article><article><h3>Conteúdo</h3><p>Histórias que apresentam o que você faz de melhor.</p></article></div></section><section id="contato"><h2>Qual é a sua próxima ideia?</h2><p>Este é um projeto fictício gerado pelo modo demonstração do Forge. Nenhum formulário envia dados.</p><a href="#inicio">Voltar ao início</a></section></main><footer><p>Aurora / Demonstração offline JPXFORGE</p></footer>',
        css: ':root { color-scheme: light; } * { box-sizing: border-box; } body { margin: 0; background: #f6f6ed; color: #152c31; font-family: Arial, sans-serif; line-height: 1.6; } header, footer { padding: 24px 7%; } header { display: flex; justify-content: space-between; border-bottom: 1px solid #d1dbd2; } a { color: inherit; } nav { display: flex; gap: 24px; } main section { padding: 64px 7%; } .hero { background: #152c31; color: #f6f6ed; } h1 { max-width: 850px; font-size: clamp(42px, 7vw, 86px); line-height: 1.08; margin: 20px 0; } h2 { font-size: 34px; line-height: 1.2; max-width: 600px; } .eyebrow { color: #b6ef89; letter-spacing: 2px; } .button { display: inline-block; padding: 15px 28px; margin-top: 24px; border-radius: 32px; background: #b6ef89; color: #152c31; text-decoration: none; } .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; } article { padding: 24px; border: 1px solid #c1cdbf; border-radius: 16px; } #contato { background: #e5eddf; }',
      },
    };
    if (!responses[role]) throw new Error(`Demonstração não implementa o papel ${role}`);
    return { content: JSON.stringify(responses[role]), provider: "demo", model: "fixture-local", usedFallback: false, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
}
