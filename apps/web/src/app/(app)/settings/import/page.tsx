'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Papa from 'papaparse';
import { Upload, FileText, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Importador CSV de outros CRMs (Kommo, Pipedrive, HubSpot).
 *
 * Fluxo:
 *  1. Upload do CSV — papaparse no cliente, mostra preview.
 *  2. Mapping wizard — usuário confirma qual coluna do CSV vai pra cada campo Neura.
 *     Auto-sugestões: matching por nome de coluna (Kommo em PT/EN/ES).
 *  3. (Leads apenas) Escolhe funnel destino + default stage pra rows sem match de stage.
 *  4. Commit em batches de até 500 rows. Backend faz upsert idempotente.
 *
 * Tudo client-side até o commit — sem upload do binário ao server, sem state intermediário
 * no banco. Re-rodar o mesmo CSV não duplica nada (idempotência via externalId).
 */

type ImportKind = 'contacts' | 'leads';

interface FunnelOpt {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

// ============================ Mapping ============================

// Lista de campos Neura por tipo. Cada um aceita 0+ colunas do CSV. Auto-suggest
// procura nessas patterns (lowercase substring) no header.
const CONTACT_FIELDS = [
  { key: 'externalId', label: 'ID externo', patterns: ['id'], required: false },
  { key: 'name', label: 'Nome', patterns: ['nome', 'name', 'nombre'], required: false },
  { key: 'phone', label: 'Telefone', patterns: ['telefone', 'phone', 'tel', 'celular', 'whatsapp'], required: false },
  { key: 'email', label: 'Email', patterns: ['email', 'correo', 'e-mail'], required: false },
  { key: 'tags', label: 'Etiquetas (vírgula/ponto-e-vírgula)', patterns: ['tag', 'etiqueta'], required: false },
] as const;

const LEAD_FIELDS = [
  { key: 'externalId', label: 'ID externo do lead', patterns: ['id'], required: false },
  { key: 'title', label: 'Título do lead', patterns: ['title', 'titulo', 'name', 'nome', 'lead', 'oportunidade'], required: true },
  { key: 'value', label: 'Valor', patterns: ['valor', 'price', 'preço', 'precio', 'amount'], required: false },
  { key: 'stageName', label: 'Etapa', patterns: ['stage', 'status', 'etapa', 'fase'], required: false },
  { key: 'responsibleEmail', label: 'Email do responsável', patterns: ['responsible email', 'responsável email', 'owner email', 'agente email'], required: false },
  { key: 'responsibleName', label: 'Nome do responsável', patterns: ['responsável', 'responsable', 'responsible', 'owner', 'agente', 'sale'], required: false },
  { key: 'contactPhone', label: 'Telefone do contato', patterns: ['contact phone', 'telefone', 'phone', 'tel', 'celular'], required: false },
  { key: 'contactEmail', label: 'Email do contato', patterns: ['contact email', 'email do contato', 'cliente email'], required: false },
  { key: 'contactExternalId', label: 'ID externo do contato', patterns: ['contact id', 'contato id'], required: false },
  { key: 'tags', label: 'Etiquetas', patterns: ['tag', 'etiqueta'], required: false },
] as const;

type FieldKey = (typeof CONTACT_FIELDS)[number]['key'] | (typeof LEAD_FIELDS)[number]['key'];

function suggestMapping(
  headers: string[],
  fields: ReadonlyArray<{ key: string; patterns: readonly string[] }>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const field of fields) {
    const match = headers.find((h) => {
      const lh = h.toLowerCase().trim();
      return field.patterns.some((p) => lh.includes(p));
    });
    if (match) mapping[field.key] = match;
  }
  return mapping;
}

// ============================ Page ============================

export default function ImportPage() {
  const [kind, setKind] = useState<ImportKind>('contacts');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [funnelId, setFunnelId] = useState<string>('');
  const [defaultStageId, setDefaultStageId] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<null | {
    created: number;
    updated: number;
    skipped: number;
    labelsCreated: number;
    errors: Array<{ row: number; reason: string }>;
  }>(null);

  const { data: funnelsData } = useQuery<{ funnels: FunnelOpt[] }>({
    queryKey: ['funnels-with-stages'],
    queryFn: () => api('/api/kanban/funnels?includeStages=true'),
    enabled: kind === 'leads',
  });

  const funnelStages = funnelsData?.funnels.find((f) => f.id === funnelId)?.stages ?? [];

  const fields = kind === 'contacts' ? CONTACT_FIELDS : LEAD_FIELDS;

  // ============================ File parsing ============================

  function handleFile(f: File) {
    setFile(f);
    setResult(null);
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: true,
      // Kommo CSV vem em UTF-8; ASCII encoding também funciona com utf-8.
      // BOM é tratado automaticamente pelo papaparse.
      complete: (res) => {
        const data = res.data;
        const headerList = res.meta.fields ?? [];
        setHeaders(headerList);
        setRows(data);
        setMapping(suggestMapping(headerList, fields));
        if (res.errors.length > 0) {
          toast.warning(
            `${res.errors.length} linha(s) com erro de parse — verifique as primeiras 5 abaixo.`,
          );
        }
      },
      error: (err) => {
        toast.error(`Erro ao ler CSV: ${err.message}`);
      },
    });
  }

  function reset() {
    setFile(null);
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
  }

  // ============================ Build payload ============================

  function buildContactRow(row: Record<string, string>) {
    const get = (k: string) => (mapping[k] ? row[mapping[k]]?.trim() || null : null);
    const tagsRaw = get('tags');
    const tags = tagsRaw
      ? tagsRaw
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    // customAttrs: TODAS as colunas que NÃO estão em mapping vão pra customAttrs
    const mappedColumns = new Set(Object.values(mapping));
    const customAttrs: Record<string, unknown> = {};
    for (const h of headers) {
      if (!mappedColumns.has(h) && row[h]?.trim()) {
        customAttrs[h] = row[h].trim();
      }
    }
    return {
      externalId: get('externalId'),
      name: get('name'),
      phone: get('phone'),
      email: get('email'),
      tags,
      customAttrs,
    };
  }

  function buildLeadRow(row: Record<string, string>) {
    const get = (k: string) => (mapping[k] ? row[mapping[k]]?.trim() || null : null);
    const tagsRaw = get('tags');
    const tags = tagsRaw
      ? tagsRaw
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const mappedColumns = new Set(Object.values(mapping));
    const customAttrs: Record<string, unknown> = {};
    for (const h of headers) {
      if (!mappedColumns.has(h) && row[h]?.trim()) {
        customAttrs[h] = row[h].trim();
      }
    }
    return {
      externalId: get('externalId'),
      title: get('title') ?? '',
      value: get('value'),
      stageName: get('stageName'),
      responsibleName: get('responsibleName'),
      responsibleEmail: get('responsibleEmail'),
      contactPhone: get('contactPhone'),
      contactEmail: get('contactEmail'),
      contactExternalId: get('contactExternalId'),
      tags,
      customAttrs,
    };
  }

  // ============================ Commit ============================

  async function commit() {
    if (importing) return;
    const required = fields.filter((f) => f.required);
    for (const r of required) {
      if (!mapping[r.key]) {
        toast.error(`Mapeie o campo obrigatório "${r.label}" antes de importar.`);
        return;
      }
    }
    if (kind === 'leads') {
      if (!funnelId) {
        toast.error('Escolha um funil destino.');
        return;
      }
      if (!defaultStageId) {
        toast.error('Escolha uma etapa padrão.');
        return;
      }
    }

    setImporting(true);
    setResult(null);
    const BATCH_SIZE = 500;
    const totalStats = {
      created: 0,
      updated: 0,
      skipped: 0,
      labelsCreated: 0,
      errors: [] as Array<{ row: number; reason: string }>,
    };

    try {
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        const body =
          kind === 'contacts'
            ? { source: 'csv', rows: batch.map(buildContactRow) }
            : {
                source: 'csv',
                funnelId,
                defaultStageId,
                rows: batch.map(buildLeadRow),
              };
        const res = await api<{
          stats: typeof totalStats;
        }>(`/api/import/${kind}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        totalStats.created += res.stats.created;
        totalStats.updated += res.stats.updated;
        totalStats.skipped += res.stats.skipped;
        totalStats.labelsCreated += res.stats.labelsCreated;
        // Ajusta numeração dos erros pra refletir a linha do CSV original
        for (const e of res.stats.errors) {
          totalStats.errors.push({ row: e.row + start, reason: e.reason });
        }
        toast.message(
          `Lote ${Math.floor(start / BATCH_SIZE) + 1} — ${res.stats.created + res.stats.updated}/${batch.length} processados.`,
        );
      }
      setResult(totalStats);
      toast.success(
        `Importação concluída: ${totalStats.created} criados, ${totalStats.updated} atualizados.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao importar');
    } finally {
      setImporting(false);
    }
  }

  const previewRows = useMemo(() => rows.slice(0, 5), [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Importar de outro CRM</h1>
        <p className="text-muted-foreground">
          Sobe arquivos CSV exportados do Kommo, Pipedrive, HubSpot, etc. para migrar contatos e
          leads. Idempotente: re-rodar com o mesmo arquivo não duplica registros.
        </p>
      </div>

      {/* Kind selector */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <div className="space-y-2">
          <Label>O que você está importando?</Label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setKind('contacts');
                reset();
              }}
              className={`rounded-lg border p-4 text-left transition ${
                kind === 'contacts'
                  ? 'border-primary bg-primary/5'
                  : 'hover:border-foreground/30'
              }`}
            >
              <p className="font-semibold">Contatos</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pessoas/empresas. Nome, telefone, email, etiquetas, atributos customizados.
              </p>
            </button>
            <button
              type="button"
              onClick={() => {
                setKind('leads');
                reset();
              }}
              className={`rounded-lg border p-4 text-left transition ${
                kind === 'leads'
                  ? 'border-primary bg-primary/5'
                  : 'hover:border-foreground/30'
              }`}
            >
              <p className="font-semibold">Leads / Cards</p>
              <p className="text-xs text-muted-foreground mt-1">
                Negócios/oportunidades. Vão pro funil que você escolher, na etapa que indicar.
              </p>
            </button>
          </div>
        </div>

        {/* Funnel destination (leads only) */}
        {kind === 'leads' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Funil destino *</Label>
              <Select
                value={funnelId}
                onValueChange={(v) => {
                  setFunnelId(v);
                  setDefaultStageId('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Escolha o funil" />
                </SelectTrigger>
                <SelectContent>
                  {funnelsData?.funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Etapa padrão *</Label>
              <Select
                value={defaultStageId}
                onValueChange={setDefaultStageId}
                disabled={!funnelId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={funnelId ? 'Escolha' : 'Funil antes'} />
                </SelectTrigger>
                <SelectContent>
                  {funnelStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Pra leads cujo &quot;stageName&quot; do CSV não casar com nenhuma etapa do funil.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Upload */}
      {!file && (
        <label
          htmlFor="csv-upload"
          className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed bg-muted/20 p-12 text-center cursor-pointer hover:bg-muted/40 transition"
        >
          <Upload className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-semibold">Clique para enviar ou arraste o CSV aqui</p>
            <p className="text-xs text-muted-foreground mt-1">
              Aceita .csv exportado do Kommo (com codificação ASCII). Pra arquivos grandes,
              processa em lotes de 500 linhas.
            </p>
          </div>
          <input
            id="csv-upload"
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </label>
      )}

      {/* Preview + mapping */}
      {file && headers.length > 0 && (
        <>
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <div>
                  <p className="font-semibold">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rows.length.toLocaleString('pt-BR')} linhas · {headers.length} colunas
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={importing}>
                Trocar arquivo
              </Button>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div>
              <h2 className="font-semibold">Mapeamento</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Confirme qual coluna do CSV alimenta cada campo do Neura. Auto-sugerido pelo
                nome da coluna. Colunas não mapeadas viram atributos customizados.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1">
                    {f.label}
                    {f.required && <span className="text-destructive">*</span>}
                    {mapping[f.key] && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                  </Label>
                  <Select
                    value={mapping[f.key] ?? 'none'}
                    onValueChange={(v) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (v === 'none') delete next[f.key];
                        else next[f.key] = v;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Não mapear —</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {/* Preview table */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h2 className="font-semibold">Pré-visualização (primeiras 5 linhas)</h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="text-xs w-full">
                <thead className="bg-muted/40">
                  <tr>
                    {headers.map((h) => (
                      <th
                        key={h}
                        className="p-2 text-left font-medium whitespace-nowrap border-r last:border-r-0"
                      >
                        {h}
                        {Object.values(mapping).includes(h) && (
                          <span className="ml-1 text-emerald-600">●</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className="border-t">
                      {headers.map((h) => (
                        <td
                          key={h}
                          className="p-2 whitespace-nowrap border-r last:border-r-0 max-w-xs truncate"
                          title={row[h] ?? ''}
                        >
                          {row[h] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Commit */}
          <div className="flex items-center justify-end gap-3">
            <p className="text-xs text-muted-foreground">
              Vai importar {rows.length.toLocaleString('pt-BR')} linha(s) em lotes de 500.
            </p>
            <Button onClick={commit} disabled={importing || rows.length === 0}>
              {importing ? (
                'Importando...'
              ) : (
                <>
                  Importar agora
                  <ChevronRight className="ml-1 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </>
      )}

      {/* Result */}
      {result && (
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <h2 className="font-semibold">Importação concluída</h2>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-emerald-600">{result.created}</p>
              <p className="text-xs text-muted-foreground">Criados</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-blue-600">{result.updated}</p>
              <p className="text-xs text-muted-foreground">Atualizados</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-amber-600">{result.skipped}</p>
              <p className="text-xs text-muted-foreground">Pulados</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold">{result.labelsCreated}</p>
              <p className="text-xs text-muted-foreground">Etiquetas novas</p>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                {result.errors.length} erro(s) — primeiros 20:
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground max-h-48 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    Linha {e.row}: {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={reset}>
            Importar outro arquivo
          </Button>
        </div>
      )}
    </div>
  );
}
