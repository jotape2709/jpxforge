import { BriefingInput, Spec, SpecSchema } from "@jpxforge/shared";
import { ModelRouter } from "../model-router.js";

/**
 * NINA — Product Owner
 * Pega briefing cru (texto de WhatsApp, formulário, o que vier)
 * e devolve um Spec estruturado e validado. É a porta de entrada
 * da fábrica: briefing bagunçado entra, spec limpa sai.
 */

const SYSTEM_PROMPT = `Você é Nina, Product Owner da jpxforge, uma fábrica de software.
Sua função é transformar briefings crus de clientes (texto de WhatsApp, formulários, mensagens soltas)
em uma especificação estruturada de projeto.

Responda APENAS com um JSON válido neste formato exato:
{
  "title": "nome curto do projeto",
  "service_type": "landing_page | site_institucional | automacao | dashboard | api | outro",
  "summary": "resumo do que o cliente quer em 2-3 frases",
  "business": {
    "client_name": "nome do negócio do cliente",
    "niche": "nicho/segmento",
    "value_proposition": "proposta de valor principal",
    "call_to_action": "CTA desejado (ex: WhatsApp, agendar, comprar)"
  },
  "sections": ["seções que a entrega deve ter, em ordem"],
  "requirements": ["requisitos objetivos extraídos do briefing"],
  "brand": { "colors": ["cores mencionadas ou inferidas do nicho, em hex"], "tone": "tom de voz" },
  "deadline_days": 7
}

Regras:
- Se o briefing não mencionar algo, INFIRA com bom senso a partir do nicho — nunca deixe arrays vazios.
- sections para landing_page segue a estrutura: Hero, Prova Social, Benefícios/Features, Oferta/Preços, FAQ, CTA final.
- Escreva tudo em português brasileiro.
- NÃO inclua markdown, comentários ou texto fora do JSON.`;

export async function briefingToSpec(
  router: ModelRouter,
  briefing: BriefingInput,
  projectId: string
): Promise<{ spec: Spec; model: string; usedFallback: boolean }> {
  const leadInfo = briefing.lead
    ? `\nDados do lead: ${JSON.stringify(briefing.lead)}`
    : "";

  const result = await router.chat(
    "product_owner",
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Briefing (origem: ${briefing.source}):\n${briefing.raw_text}${leadInfo}`,
      },
    ],
    { jsonMode: true, temperature: 0.2, projectId }
  );

  // DeepSeek json_object garante JSON válido; zod garante o schema
  const parsed = SpecSchema.parse(JSON.parse(result.content));
  return {
    spec: parsed,
    model: `${result.provider}/${result.model}`,
    usedFallback: result.usedFallback,
  };
}
