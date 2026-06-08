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
  'page.kanban.title': { pt: 'Kanban', es: 'Kanban' },
  'page.calendar.title': { pt: 'Calendário', es: 'Calendario' },
  'page.calendar.subtitle': {
    pt: 'Eventos da equipe — aplicações, manutenções, reparações e tarefas dos cards. Cada empresa tem seu próprio calendário.',
    es: 'Eventos del equipo — aplicaciones, mantenimientos, reparaciones y tareas de las cards. Cada empresa tiene su propio calendario.',
  },
  'page.contacts.title': { pt: 'Contatos', es: 'Contactos' },
  'page.reports.title': { pt: 'Relatórios', es: 'Reportes' },
  'page.inboxes.title': { pt: 'Inboxes', es: 'Bandejas de entrada' },
  'page.inbox.title': { pt: 'Conversas', es: 'Conversaciones' },
  'page.import.title': { pt: 'Importar de outro CRM', es: 'Importar desde otro CRM' },

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
};

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
  ready: boolean;
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
    (key: string): string => {
      return TRANSLATIONS[key]?.[lang] ?? key;
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
