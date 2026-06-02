/**
 * Welcome flow presets por tipo de negócio. Cada preset:
 * - id estável (usado no apply-preset endpoint)
 * - nome humano (exibido no wizard)
 * - prompt template (suporta {{contact.name}})
 * - lista de opções com label + matchKeywords + targetLabelName + targetFunnelName
 *
 * O endpoint apply-preset resolve labelName/funnelName procurando labels/funnels
 * existentes no workspace por nome (case-insensitive). Se não existir, cria com defaults.
 */

export interface WelcomePresetOption {
  position: number;
  label: string;
  description?: string;
  matchKeywords: string[];
  targetLabelName: string;
  targetFunnelName?: string;
  targetStageName?: string;
  targetUserName?: string;
  // Mensagem enviada ao cliente após selecionar essa opção. Suporta placeholders
  // {{agent.name}} e {{contact.name}}. Quando omitido, usa fallback natural genérico.
  confirmationText?: string;
}

export interface WelcomePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  fallbackLabelName?: string;
  fallbackFunnelName?: string;
  fallbackUserName?: string;
  options: WelcomePresetOption[];
}

export const WELCOME_PRESETS: WelcomePreset[] = [
  {
    id: 'ecommerce',
    name: 'E-commerce',
    description: 'Loja online com vendas, suporte pós-venda e trocas',
    prompt: 'Olá {{contact.name}}! Como podemos te ajudar hoje?',
    fallbackLabelName: 'Geral',
    options: [
      {
        position: 1,
        label: 'Comprar',
        description: 'Quero fazer um pedido',
        matchKeywords: ['comprar', 'pedido', 'produto', 'preço', 'orçamento'],
        targetLabelName: 'Vendas',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Status do pedido',
        description: 'Quero saber onde está meu pedido',
        matchKeywords: ['pedido', 'rastreio', 'entrega', 'chegou'],
        targetLabelName: 'Pós-venda',
      },
      {
        position: 3,
        label: 'Troca ou devolução',
        description: 'Tive problema com o produto',
        matchKeywords: ['troca', 'devolução', 'defeito', 'reembolso'],
        targetLabelName: 'Trocas',
      },
      {
        position: 4,
        label: 'Outro assunto',
        description: 'Atendimento geral',
        matchKeywords: [],
        targetLabelName: 'Geral',
      },
    ],
  },
  {
    id: 'services',
    name: 'Serviços',
    description: 'Prestação de serviços (consultoria, freelance, agência)',
    prompt: 'Oi {{contact.name}}, em que posso ajudar?',
    fallbackLabelName: 'Geral',
    options: [
      {
        position: 1,
        label: 'Orçamento',
        description: 'Quero solicitar uma proposta',
        matchKeywords: ['orçamento', 'proposta', 'cotação', 'valor', 'preço'],
        targetLabelName: 'Lead',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Acompanhar projeto',
        description: 'Já sou cliente e quero atualização',
        matchKeywords: ['projeto', 'andamento', 'status', 'cliente'],
        targetLabelName: 'Projeto ativo',
      },
      {
        position: 3,
        label: 'Suporte',
        description: 'Tenho uma dúvida ou problema',
        matchKeywords: ['ajuda', 'suporte', 'problema', 'erro', 'dúvida'],
        targetLabelName: 'Suporte',
      },
    ],
  },
  {
    id: 'support',
    name: 'Suporte técnico',
    description: 'Helpdesk, SaaS, software com tickets',
    prompt: 'Olá {{contact.name}}! Precisa de ajuda? Selecione abaixo:',
    fallbackLabelName: 'Triagem',
    options: [
      {
        position: 1,
        label: 'Problema urgente',
        description: 'Sistema fora do ar ou bloqueado',
        matchKeywords: ['urgente', 'fora do ar', 'caiu', 'bug crítico', 'parou'],
        targetLabelName: 'Urgente',
      },
      {
        position: 2,
        label: 'Dúvida de uso',
        description: 'Como funciona uma feature',
        matchKeywords: ['como', 'dúvida', 'uso', 'funciona'],
        targetLabelName: 'Dúvida',
      },
      {
        position: 3,
        label: 'Solicitar feature',
        description: 'Sugestão de melhoria',
        matchKeywords: ['feature', 'sugestão', 'melhoria', 'gostaria'],
        targetLabelName: 'Feature request',
      },
      {
        position: 4,
        label: 'Cobrança',
        description: 'Pagamento, plano, fatura',
        matchKeywords: ['fatura', 'pagamento', 'plano', 'cobrança', 'cartão'],
        targetLabelName: 'Cobrança',
      },
    ],
  },
  {
    id: 'agency',
    name: 'Agência',
    description: 'Agência de marketing/design com múltiplos serviços',
    prompt: 'Olá {{contact.name}}, que tipo de serviço você procura?',
    fallbackLabelName: 'Triagem',
    options: [
      {
        position: 1,
        label: 'Marketing digital',
        description: 'Tráfego pago, SEO, social',
        matchKeywords: ['marketing', 'tráfego', 'ads', 'seo', 'social media'],
        targetLabelName: 'Marketing',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 2,
        label: 'Design',
        description: 'Identidade visual, web design',
        matchKeywords: ['design', 'logo', 'identidade', 'site', 'web'],
        targetLabelName: 'Design',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 3,
        label: 'Desenvolvimento',
        description: 'Sites, apps, sistemas',
        matchKeywords: ['site', 'app', 'sistema', 'dev', 'programação'],
        targetLabelName: 'Dev',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
      },
      {
        position: 4,
        label: 'Outro',
        description: 'Outro tipo de projeto',
        matchKeywords: [],
        targetLabelName: 'Geral',
      },
    ],
  },
  {
    id: 'drones-agro',
    name: 'Drones agrícolas',
    description: 'Venda + manutenção de drones para pulverização, siembra e monitoreo',
    prompt:
      '¡Hola {{contact.name}}! Gracias por escribirnos. Somos especialistas en drones para soluciones agrícolas — pulverización, siembra y monitoreo aéreo. ¿En qué podemos ayudarte? Elegí una opción:',
    fallbackLabelName: 'Lead',
    fallbackUserName: 'Ariel',
    options: [
      {
        position: 1,
        label: 'Comprar drone',
        description: 'Quiero adquirir un equipo',
        matchKeywords: ['comprar', 'cotización', 'precio', 'orçamento', 'cotação'],
        targetLabelName: 'Vendas',
        targetFunnelName: 'Vendas',
        targetStageName: 'Novo lead',
        targetUserName: 'Ariel',
        confirmationText:
          '¡Excelente, {{contact.name}}! {{agent.name}} se va a poner en contacto contigo en breve para mostrarte los modelos disponibles y armar una cotización adaptada al tipo de cultivo y a las hectáreas que necesitás cubrir.',
      },
      {
        position: 2,
        label: 'Conocer / saber más',
        description: 'Quiero entender cómo funciona',
        matchKeywords: ['información', 'saber', 'conocer', 'detalles', 'cómo'],
        targetLabelName: 'Lead',
        targetFunnelName: 'Lead',
        targetStageName: 'Triagem',
        targetUserName: 'Ariel',
        confirmationText:
          '¡Genial! {{agent.name}} te va a contactar enseguida para contarte cómo nuestros drones ayudan a optimizar pulverización, siembra y monitoreo de cultivos — y resolver cualquier duda que tengas sobre el equipo.',
      },
      {
        position: 3,
        label: 'Mantenimiento preventivo',
        description: 'Revisión de mi equipo',
        matchKeywords: ['mantenimiento', 'revisión', 'check', 'manutenção'],
        targetLabelName: 'Manutenção',
        targetFunnelName: 'Manutenção',
        targetStageName: 'Solicitação',
        targetUserName: 'Marcos',
        confirmationText:
          '¡Recibido! {{agent.name}} se va a comunicar contigo para coordinar la revisión preventiva de tu equipo y dejarlo listo para la temporada de aplicación.',
      },
      {
        position: 4,
        label: 'Reparación / falla',
        description: 'Mi drone dejó de funcionar',
        matchKeywords: ['quebrou', 'falla', 'reparo', 'conserto', 'problema', 'no anda'],
        targetLabelName: 'Reparação',
        targetFunnelName: 'Reparação',
        targetStageName: 'Diagnóstico',
        targetUserName: 'Diego',
        confirmationText:
          'Entendido, vamos a resolverlo. {{agent.name}} se va a contactar contigo para hacer el diagnóstico y guiarte sobre los próximos pasos lo antes posible.',
      },
    ],
  },
];

export function findPresetById(id: string): WelcomePreset | null {
  return WELCOME_PRESETS.find((p) => p.id === id) ?? null;
}
