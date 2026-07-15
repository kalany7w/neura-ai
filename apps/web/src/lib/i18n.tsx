'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Internacionalização simples PT-BR / ES.
 *
 * Decisões:
 * - Sem lib externa: o app é Next 15 com App Router e a tradução cobre só strings
 *   do shell (sidebar + headers principais). next-intl seria overkill aqui.
 * - Persistência: localStorage. Sem state no backend (per-user) por enquanto —
 *   mais simples e suficiente: cada device do mesmo user pode ter idioma diferente
 *   se quiser.
 * - Hydration-safe: o server renderiza sempre o default (pt). Depois do mount,
 *   o cliente lê localStorage e troca. Pra evitar flash de texto errado, o
 *   provider expõe `ready` — componentes podem optar por mostrar skeleton até
 *   hidratar, mas a prática default é "mostra pt no SSR e atualiza no client".
 *
 * Pra adicionar uma nova chave: edita TRANSLATIONS abaixo. Chaves não traduzidas
 * caem no fallback (a própria key) — fica visível que falta tradução.
 */

export type Lang = 'pt' | 'es';

const TRANSLATIONS: Record<string, Record<Lang, string>> = {
  // Sidebar groups
  'sidebar.group.operation': { pt: 'Operação', es: 'Operación' },
  'sidebar.group.management': { pt: 'Gestão', es: 'Gestión' },
  'sidebar.group.settings': { pt: 'Configurações', es: 'Configuración' },

  // Sidebar items
  'sidebar.dashboard': { pt: 'Dashboard', es: 'Panel' },
  'sidebar.conversations': { pt: 'Conversas', es: 'Conversaciones' },
  'sidebar.kanban': { pt: 'Kanban', es: 'Kanban' },
  'sidebar.calendar': { pt: 'Calendário', es: 'Calendario' },
  'sidebar.contacts': { pt: 'Contatos', es: 'Contactos' },
  'sidebar.inboxes': { pt: 'Inboxes', es: 'Inboxes' },
  'sidebar.reports': { pt: 'Relatórios', es: 'Reportes' },
  'sidebar.templates': { pt: 'Templates', es: 'Plantillas' },
  'sidebar.welcome_flows': { pt: 'Fluxo de boas-vindas', es: 'Flujo de bienvenida' },
  'sidebar.kb': { pt: 'Base de conhecimento', es: 'Base de conocimiento' },
  'sidebar.labels': { pt: 'Etiquetas', es: 'Etiquetas' },
  'sidebar.members': { pt: 'Membros', es: 'Miembros' },
  'sidebar.automations': { pt: 'Automações', es: 'Automatizaciones' },
  'sidebar.sla': { pt: 'SLA', es: 'SLA' },
  'sidebar.csat': { pt: 'CSAT / NPS', es: 'CSAT / NPS' },
  'sidebar.integrations': { pt: 'Integrações', es: 'Integraciones' },
  'sidebar.import': { pt: 'Importar CSV', es: 'Importar CSV' },
  'sidebar.custom_attributes': { pt: 'Atributos', es: 'Atributos' },
  'sidebar.api_keys': { pt: 'API Keys', es: 'API Keys' },
  'sidebar.audit': { pt: 'Audit log', es: 'Registro de auditoría' },

  // Workspace / user
  'workspace.your_workspaces': { pt: 'Seus workspaces', es: 'Tus empresas' },
  'workspace.new': { pt: 'Novo workspace', es: 'Nueva empresa' },
  'workspace.switched': { pt: 'Workspace trocado', es: 'Empresa cambiada' },
  'workspace.switch_error': { pt: 'Erro ao trocar workspace', es: 'Error al cambiar de empresa' },
  'user.sign_out': { pt: 'Sair', es: 'Cerrar sesión' },
  'user.theme': { pt: 'Tema', es: 'Tema' },
  'user.language': { pt: 'Idioma', es: 'Idioma' },

  // Pages — headers
  'page.dashboard.title': { pt: 'Dashboard', es: 'Panel' },
  'page.dashboard.welcome': { pt: 'Bem-vindo', es: 'Bienvenido' },
  'page.dashboard.subtitle': {
    pt: 'Visão geral do workspace.',
    es: 'Vista general del workspace.',
  },
  'page.kanban.title': { pt: 'Kanban', es: 'Kanban' },
  'page.calendar.title': { pt: 'Calendário', es: 'Calendario' },
  'page.calendar.subtitle': {
    pt: 'Eventos da equipe — aplicações, manutenções, reparações e tarefas dos cards. Cada empresa tem seu próprio calendário.',
    es: 'Eventos del equipo — aplicaciones, mantenimientos, reparaciones y tareas de las cards. Cada empresa tiene su propio calendario.',
  },
  'page.contacts.title': { pt: 'Contatos', es: 'Contactos' },
  'page.contacts.subtitle': {
    pt: 'Pessoas e empresas com quem você conversa.',
    es: 'Personas y empresas con las que conversas.',
  },
  'page.reports.title': { pt: 'Relatórios', es: 'Reportes' },
  'page.reports.subtitle': {
    pt: 'Performance da equipe e tendências do workspace.',
    es: 'Rendimiento del equipo y tendencias del workspace.',
  },
  'page.inboxes.title': { pt: 'Inboxes', es: 'Bandejas de entrada' },
  'page.inboxes.subtitle': {
    pt: 'Canais conectados — WhatsApp, Telegram, Email, Webchat.',
    es: 'Canales conectados — WhatsApp, Telegram, Email, Webchat.',
  },
  'page.inbox.title': { pt: 'Conversas', es: 'Conversaciones' },
  'page.inbox.subtitle': {
    pt: 'Atenda mensagens em tempo real.',
    es: 'Atiende mensajes en tiempo real.',
  },
  'page.import.title': { pt: 'Importar de outro CRM', es: 'Importar desde otro CRM' },
  'page.import.subtitle': {
    pt: 'Sobe arquivos CSV exportados do Kommo, Pipedrive, HubSpot, etc. para migrar contatos e leads. Idempotente: re-rodar com o mesmo arquivo não duplica registros.',
    es: 'Sube archivos CSV exportados de Kommo, Pipedrive, HubSpot, etc. para migrar contactos y leads. Idempotente: volver a ejecutar con el mismo archivo no duplica registros.',
  },
  'page.profile.title': { pt: 'Meu perfil', es: 'Mi perfil' },
  'page.profile.subtitle': {
    pt: 'Edite seus dados de atendente e troque sua senha.',
    es: 'Edita tus datos de agente y cambia tu contraseña.',
  },
  'page.members.title': { pt: 'Membros', es: 'Miembros' },
  'page.members.subtitle': {
    pt: 'Convide agentes e gerencie permissões.',
    es: 'Invita agentes y gestiona permisos.',
  },
  'page.labels.title': { pt: 'Etiquetas', es: 'Etiquetas' },
  'page.labels.subtitle': {
    pt: 'Reutilize em contatos e conversas pra filtrar. Quando vincula a um funil, a etiqueta aparece APENAS em cards desse funil (escopo multi-empresa) — e ainda cria card no funil quando aplicada a uma conversa.',
    es: 'Reutilízalas en contactos y conversaciones para filtrar. Al vincular a un embudo, la etiqueta aparece SOLO en cards de ese embudo (alcance multi-empresa) — y crea card en el embudo cuando se aplica a una conversación.',
  },
  'page.templates.title': { pt: 'Templates de resposta', es: 'Plantillas de respuesta' },
  'page.templates.subtitle': {
    pt: 'Atalhos pra respostas rápidas. Digite /atalho na conversa pra expandir.',
    es: 'Atajos para respuestas rápidas. Escribe /atajo en la conversación para expandir.',
  },
  'page.kb.title': { pt: 'Base de conhecimento', es: 'Base de conocimiento' },
  'page.kb.subtitle': {
    pt: 'Documentação que a IA usa pra responder perguntas frequentes da sua empresa.',
    es: 'Documentación que la IA usa para responder preguntas frecuentes de tu empresa.',
  },
  'page.welcome_flows.title': { pt: 'Fluxo de boas-vindas', es: 'Flujo de bienvenida' },
  'page.welcome_flows.subtitle': {
    pt: 'Configure o menu interativo que recebe novos clientes em cada inbox.',
    es: 'Configura el menú interactivo que recibe a nuevos clientes en cada bandeja de entrada.',
  },
  'page.welcome_flow_editor.subtitle': { pt: 'Fluxo de boas-vindas', es: 'Flujo de bienvenida' },
  'page.sla.title': { pt: 'SLA', es: 'SLA' },
  'page.sla.subtitle': {
    pt: 'Defina tempos máximos pra primeira resposta e resolução por inbox/etiqueta.',
    es: 'Define tiempos máximos para la primera respuesta y resolución por bandeja/etiqueta.',
  },
  'page.api_keys.title': { pt: 'API Keys', es: 'API Keys' },
  'page.api_keys.subtitle': {
    pt: 'Tokens pra integrar a API do Neura com outros sistemas.',
    es: 'Tokens para integrar la API de Neura con otros sistemas.',
  },
  'page.automations.title': { pt: 'Automações', es: 'Automatizaciones' },
  'page.automations.subtitle': {
    pt: 'Regras que disparam ações automaticamente — atribuir, etiquetar, mover, enviar mensagem.',
    es: 'Reglas que disparan acciones automáticamente — asignar, etiquetar, mover, enviar mensaje.',
  },
  'page.csat.title': { pt: 'CSAT / NPS', es: 'CSAT / NPS' },
  'page.csat.subtitle': {
    pt: 'Pesquisas de satisfação enviadas após resolução das conversas.',
    es: 'Encuestas de satisfacción enviadas tras resolver las conversaciones.',
  },
  'page.audit.title': { pt: 'Audit log', es: 'Registro de auditoría' },
  'page.audit.subtitle': {
    pt: 'Histórico imutável de todas as ações sensíveis do workspace.',
    es: 'Historial inmutable de todas las acciones sensibles del workspace.',
  },
  'page.custom_attributes.title': { pt: 'Atributos customizados', es: 'Atributos personalizados' },
  'page.custom_attributes.subtitle': {
    pt: 'Campos personalizados que aparecem no side panel da conversa, em contatos e cards.',
    es: 'Campos personalizados que aparecen en el panel lateral de la conversación, en contactos y cards.',
  },
  'page.integrations.title': { pt: 'Integrações', es: 'Integraciones' },
  'page.integrations.subtitle': {
    pt: 'Conecte serviços externos — calendário, CRM, transcrição, IA.',
    es: 'Conecta servicios externos — calendario, CRM, transcripción, IA.',
  },
  'page.onboarding.title': { pt: 'Crie seu workspace', es: 'Crea tu empresa' },
  'page.onboarding.subtitle': {
    pt: 'Cada empresa tem seu próprio espaço isolado com inboxes, cards, contatos e equipe.',
    es: 'Cada empresa tiene su propio espacio aislado con bandejas, cards, contactos y equipo.',
  },

  // Common actions
  'action.save': { pt: 'Salvar', es: 'Guardar' },
  'action.cancel': { pt: 'Cancelar', es: 'Cancelar' },
  'action.delete': { pt: 'Excluir', es: 'Eliminar' },
  'action.edit': { pt: 'Editar', es: 'Editar' },
  'action.add': { pt: 'Adicionar', es: 'Añadir' },
  'action.create': { pt: 'Criar', es: 'Crear' },
  'action.search': { pt: 'Buscar', es: 'Buscar' },
  'action.loading': { pt: 'Carregando…', es: 'Cargando…' },
  'action.saving': { pt: 'Salvando…', es: 'Guardando…' },
  'action.today': { pt: 'Hoje', es: 'Hoy' },
  'action.close': { pt: 'Fechar', es: 'Cerrar' },
  'action.confirm': { pt: 'Confirmar', es: 'Confirmar' },
  'action.copy': { pt: 'Copiar', es: 'Copiar' },
  'action.export': { pt: 'Exportar', es: 'Exportar' },
  'action.filter': { pt: 'Filtrar', es: 'Filtrar' },
  'action.try_again': { pt: 'Tentar novamente', es: 'Intentar de nuevo' },
  'action.show_more': { pt: 'Ver mais', es: 'Ver más' },

  // Roles
  'role.admin': { pt: 'Administrador', es: 'Administrador' },
  'role.supervisor': { pt: 'Supervisor', es: 'Supervisor' },
  'role.agent': { pt: 'Agente', es: 'Agente' },

  // Common
  'common.error': { pt: 'Erro', es: 'Error' },
  'common.success': { pt: 'Sucesso', es: 'Éxito' },
  'common.no_data': { pt: 'Sem dados', es: 'Sin datos' },
  'common.name': { pt: 'Nome', es: 'Nombre' },
  'common.email': { pt: 'Email', es: 'Email' },
  'common.phone': { pt: 'Telefone', es: 'Teléfono' },
  'common.role': { pt: 'Papel', es: 'Rol' },
  'common.status': { pt: 'Status', es: 'Estado' },

  // Dashboard
  'dashboard.subtitle_full': {
    pt: 'Visão geral do workspace em tempo real — atualiza a cada minuto.',
    es: 'Vista general del workspace en tiempo real — se actualiza cada minuto.',
  },
  'dashboard.loading': { pt: 'Carregando dashboard…', es: 'Cargando panel…' },
  'dashboard.kpi.open': { pt: 'Conversas abertas', es: 'Conversaciones abiertas' },
  'dashboard.kpi.open_sub': { pt: '{open} abertas · {pending} pendentes', es: '{open} abiertas · {pending} pendientes' },
  'dashboard.kpi.unassigned': { pt: 'Sem agente', es: 'Sin agente' },
  'dashboard.kpi.unassigned_sub': { pt: 'Aguardando atribuição', es: 'Esperando asignación' },
  'dashboard.kpi.sla': { pt: 'SLA crítico', es: 'SLA crítico' },
  'dashboard.kpi.sla_sub': { pt: 'Cards atrasados ou no limite', es: 'Cards atrasadas o al límite' },
  'dashboard.kpi.mine': { pt: 'Minha fila', es: 'Mi fila' },
  'dashboard.kpi.mine_sub': { pt: 'Conversas atribuídas a você', es: 'Conversaciones asignadas a ti' },
  'dashboard.pipeline.open': { pt: 'Em aberto', es: 'Abiertas' },
  'dashboard.pipeline.positive': { pt: 'Positivos (30d)', es: 'Positivos (30d)' },
  'dashboard.pipeline.negative': { pt: 'Negativos (30d)', es: 'Negativos (30d)' },
  'dashboard.pipeline.conversion': { pt: 'Taxa de conversão (30d)', es: 'Tasa de conversión (30d)' },
  'dashboard.see_kanban': { pt: 'ver kanban →', es: 'ver kanban →' },
  'dashboard.see_all': { pt: 'ver todas →', es: 'ver todas →' },
  'dashboard.contacts': { pt: 'Contatos', es: 'Contactos' },
  'dashboard.active_inboxes': { pt: 'Inboxes ativas', es: 'Inboxes activas' },
  'dashboard.recent': { pt: 'Conversas recentes', es: 'Conversaciones recientes' },
  'dashboard.empty': {
    pt: 'Sem conversas em aberto. Conecte uma inbox em /inboxes.',
    es: 'Sin conversaciones abiertas. Conecta una inbox en /inboxes.',
  },

  // Dashboard — gráfico de volume
  'dashboard.volume.title': { pt: 'Volume — últimos 14 dias', es: 'Volumen — últimos 14 días' },
  'dashboard.volume.conversations': { pt: 'Conversas iniciadas', es: 'Conversaciones iniciadas' },
  'dashboard.volume.messages': { pt: 'Mensagens (in / out)', es: 'Mensajes (in / out)' },
  'dashboard.volume.received': { pt: 'Recebidas', es: 'Recibidas' },
  'dashboard.volume.sent': { pt: 'Enviadas', es: 'Enviadas' },
  'dashboard.chart_loading': { pt: 'Carregando gráfico…', es: 'Cargando gráfico…' },

  // Kanban — estado vazio
  'kanban.empty.title': { pt: 'Nenhum funil criado', es: 'Ningún embudo creado' },
  'kanban.empty.subtitle': {
    pt: 'Crie um funil pra começar a organizar conversas em estágios.',
    es: 'Crea un embudo para empezar a organizar conversaciones en etapas.',
  },
  'kanban.new_funnel': { pt: 'Novo funil', es: 'Nuevo embudo' },

  // Inbox — lista de conversas
  'inbox.subtitle_full': {
    pt: 'Atenda clientes em tempo real. Atualiza sozinho — sem refresh.',
    es: 'Atiende clientes en tiempo real. Se actualiza solo — sin refrescar.',
  },
  'inbox.tab.all': { pt: 'Todas', es: 'Todas' },
  'inbox.tab.awaiting': { pt: 'Aguardando', es: 'Esperando' },
  'inbox.tab.open': { pt: 'Abertas', es: 'Abiertas' },
  'inbox.tab.unassigned': { pt: 'Sem agente', es: 'Sin agente' },
  'inbox.tab.pending': { pt: 'Pendentes', es: 'Pendientes' },
  'inbox.tab.resolved': { pt: 'Resolvidas', es: 'Resueltas' },
  'inbox.tab.archived': { pt: 'Arquivadas', es: 'Archivadas' },
  'inbox.search_placeholder': { pt: 'Nome ou telefone…', es: 'Nombre o teléfono…' },
  'inbox.empty': { pt: 'Nenhuma conversa nesse filtro.', es: 'Ninguna conversación en este filtro.' },
  'inbox.empty_archived': { pt: 'Nenhuma conversa arquivada.', es: 'Ninguna conversación archivada.' },
  'inbox.empty_awaiting': {
    pt: 'Tudo respondido. Nenhum cliente aguardando agora.',
    es: 'Todo respondido. Ningún cliente esperando ahora.',
  },
};

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  ready: boolean;
}

/** Locale BCP-47 pra Intl (datas, números, moeda) a partir do idioma. */
export function localeFor(lang: Lang): string {
  return lang === 'es' ? 'es-419' : 'pt-BR';
}

/**
 * Formata valor monetário no locale do idioma.
 * NOTA: a moeda (currency) idealmente vem das settings do workspace — hoje o
 * default é BRL. Ao introduzir moeda por workspace, passe-a como 3º argumento.
 */
export function formatMoney(value: number, lang: Lang, currency = 'BRL'): string {
  return value.toLocaleString(localeFor(lang), {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
}

/** Data curta DD/MM/AAAA no locale do idioma. */
export function formatDateShort(iso: string | Date, lang: Lang): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString(localeFor(lang), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Tempo relativo curto ("agora"/"ahora", "5m atrás"/"hace 5m") no idioma. */
export function formatRelativeTime(iso: string | null, lang: Lang): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const es = lang === 'es';
  if (minutes < 1) return es ? 'ahora' : 'agora';
  if (minutes < 60) return es ? `hace ${minutes}m` : `${minutes}m atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return es ? `hace ${hours}h` : `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return es ? `hace ${days}d` : `${days}d atrás`;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'neura.lang';
const DEFAULT_LANG: Lang = 'pt';

export function I18nProvider({ children }: { children: ReactNode }) {
  // SSR sempre renderiza pt (default). Após mount, lê localStorage e re-renderiza
  // se for diferente. Pra evitar flash, componentes podem checar `ready`.
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'pt' || stored === 'es') {
        setLangState(stored);
      }
    } catch {
      // localStorage indisponível (private mode, etc.) — segue com default.
    }
    setReady(true);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // ignore
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      let s = TRANSLATIONS[key]?.[lang] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t, ready }), [lang, setLang, t, ready]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Hook pra traduzir strings.
 *
 * Uso: `const { t, lang, setLang } = useT(); t('sidebar.dashboard')`.
 * Fora do Provider (caso erro), retorna fallback que devolve a chave —
 * a tela ainda renderiza, só sem tradução.
 */
export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return {
      lang: DEFAULT_LANG,
      setLang: () => undefined,
      t: (k) => k,
      ready: true,
    };
  }
  return ctx;
}
