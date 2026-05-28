/**
 * Presets de funil/stages por tipo de empresa. Cada preset:
 * - id estável (usado no body do POST /funnels pra disparar criação dos stages).
 * - nome + descrição humanos (exibidos no dialog "Novo funil").
 * - lista ordenada de stages (name, color, outcome opcional).
 *
 * Quando o admin escolhe um preset ao criar um funil, os stages são criados na
 * mesma transação. Outros podem ser adicionados depois via "Adicionar lista".
 * Por default deixamos outcome=null (stages abertos) — admin marca POSITIVE/
 * NEGATIVE manualmente se quiser fechar cards ao chegarem ali.
 */

export interface FunnelPresetStage {
  name: string;
  color: string;
  outcome?: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;
}

export interface FunnelPresetAttribute {
  key: string; // snake_case
  label: string;
  type: 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';
  appliesTo: 'CONTACT' | 'CONVERSATION' | 'CARD';
  options?: string[]; // só pra SELECT
}

export interface FunnelPreset {
  id: string;
  name: string;
  description: string;
  stages: FunnelPresetStage[];
  // Atributos customizados criados em conjunto com o funnel (idempotente: upsert por
  // workspaceId+key). Útil pra seedar "Vinculo" do Caltech com opções predefinidas.
  defaultAttributes?: FunnelPresetAttribute[];
}

export const FUNNEL_PRESETS: FunnelPreset[] = [
  {
    id: 'xag',
    name: 'XAG (drones)',
    description: 'Vendas + manutenção + reparação de drones agrícolas',
    stages: [
      { name: 'New Lead', color: '#94a3b8' },
      { name: 'Venta', color: '#10b981' },
      { name: 'Mantenimiento', color: '#3b82f6' },
      { name: 'Reparación', color: '#f59e0b' },
    ],
  },
  {
    id: 'caltech',
    name: 'Caltech (alta volumetria)',
    description: 'Funil completo de vendas — leads, qualificações, follow-ups, expansão',
    stages: [
      { name: 'Etapa de Leads de entrada', color: '#94a3b8' },
      { name: 'Contacto', color: '#64748b' },
      { name: 'Calificaciones', color: '#6366f1' },
      { name: 'Carinata Proceso', color: '#8b5cf6' },
      { name: 'Leads Potenciales', color: '#3b82f6' },
      { name: 'Visita Tecnica', color: '#06b6d4' },
      { name: 'Propuesta', color: '#0ea5e9' },
      { name: 'Follow up 1', color: '#f59e0b' },
      { name: 'Follow up 2', color: '#f97316' },
      { name: 'Follow up 3', color: '#ef4444' },
      { name: 'Septiembre', color: '#a855f7' },
      { name: 'Carinata del año que viene', color: '#ec4899' },
      { name: 'Llamadas que respondieron a un mensaje', color: '#14b8a6' },
      { name: 'Venta', color: '#10b981' },
      { name: 'Venta de consultores', color: '#22c55e' },
      { name: 'Expansion', color: '#84cc16' },
      { name: 'Post venta', color: '#65a30d' },
    ],
    defaultAttributes: [
      {
        key: 'vinculo',
        label: 'Vinculo',
        type: 'SELECT',
        appliesTo: 'CARD',
        options: [
          'Não atendeu',
          'Telefone apagado',
          'Já não tem interesse',
          'Interesse em setembro',
          'Vai avisar',
          'Muito caro, quer mais econômico',
          'Comprou outro',
          'Engano',
          'Segmento',
        ],
      },
    ],
  },
];

export function findFunnelPresetById(id: string): FunnelPreset | null {
  return FUNNEL_PRESETS.find((p) => p.id === id) ?? null;
}
