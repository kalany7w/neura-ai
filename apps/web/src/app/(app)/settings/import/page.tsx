'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Papa from 'papaparse';
import { Upload, FileText, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT, localeFor } from '@/lib/i18n';
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
// `label` guarda a CHAVE de i18n — resolvida via t(f.label) no render.
const CONTACT_FIELDS = [
  {
    key: 'externalId',
    label: 'settings_import.field.external_id',
    patterns: ['id'],
    required: false,
  },
  { key: 'name', label: 'common.name', patterns: ['nome', 'name', 'nombre'], required: false },
  {
    key: 'phone',
    label: 'common.phone',
    patterns: ['telefone', 'phone', 'tel', 'celular', 'whatsapp'],
    required: false,
  },
  { key: 'email', label: 'common.email', patterns: ['email', 'correo', 'e-mail'], required: false },
  {
    key: 'tags',
    label: 'settings_import.field.tags_contact',
    patterns: ['tag', 'etiqueta'],
    required: false,
  },
] as const;

const LEAD_FIELDS = [
  {
    key: 'externalId',
    label: 'settings_import.field.external_id_lead',
    patterns: ['id'],
    required: false,
  },
  {
    key: 'title',
    label: 'settings_import.field.title',
    patterns: ['title', 'titulo', 'name', 'nome', 'lead', 'oportunidade'],
    required: true,
  },
  {
    key: 'value',
    label: 'settings_import.field.value',
    patterns: ['valor', 'price', 'preço', 'precio', 'amount'],
    required: false,
  },
  {
    key: 'stageName',
    label: 'settings_import.field.stage',
    patterns: ['stage', 'status', 'etapa', 'fase'],
    required: false,
  },
  {
    key: 'responsibleEmail',
    label: 'settings_import.field.responsible_email',
    patterns: ['responsible email', 'responsável email', 'owner email', 'agente email'],
    required: false,
  },
  {
    key: 'responsibleName',
    label: 'settings_import.field.responsible_name',
    patterns: ['responsável', 'responsable', 'responsible', 'owner', 'agente', 'sale'],
    required: false,
  },
  {
    key: 'contactPhone',
    label: 'settings_import.field.contact_phone',
    patterns: ['contact phone', 'telefone', 'phone', 'tel', 'celular'],
    required: false,
  },
  {
    key: 'contactEmail',
    label: 'settings_import.field.contact_email',
    patterns: ['contact email', 'email do contato', 'cliente email'],
    required: false,
  },
  {
    key: 'contactExternalId',
    label: 'settings_import.field.contact_external_id',
    patterns: ['contact id', 'contato id'],
    required: false,
  },
  {
    key: 'tags',
    label: 'settings_import.field.tags',
    patterns: ['tag', 'etiqueta'],
    required: false,
  },
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
  const { t, lang } = useT();
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
          toast.warning(t('settings_import.toast_parse_errors', { n: res.errors.length }));
        }
      },
      error: (err) => {
        toast.error(t('settings_import.toast_read_error', { msg: err.message }));
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
        toast.error(t('settings_import.toast_map_required', { field: t(r.label) }));
        return;
      }
    }
    if (kind === 'leads') {
      if (!funnelId) {
        toast.error(t('settings_import.toast_choose_funnel'));
        return;
      }
      if (!defaultStageId) {
        toast.error(t('settings_import.toast_choose_stage'));
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
          t('settings_import.toast_batch', {
            n: Math.floor(start / BATCH_SIZE) + 1,
            done: res.stats.created + res.stats.updated,
            total: batch.length,
          }),
        );
      }
      setResult(totalStats);
      toast.success(
        t('settings_import.toast_done', {
          created: totalStats.created,
          updated: totalStats.updated,
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings_import.toast_error'));
    } finally {
      setImporting(false);
    }
  }

  const previewRows = useMemo(() => rows.slice(0, 5), [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('page.import.title')}</h1>
        <p className="text-muted-foreground">{t('page.import.subtitle')}</p>
      </div>

      {/* Kind selector */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <div className="space-y-2">
          <Label>{t('settings_import.what_importing')}</Label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setKind('contacts');
                reset();
              }}
              className={`rounded-lg border p-4 text-left transition ${
                kind === 'contacts' ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
              }`}
            >
              <p className="font-semibold">{t('settings_import.kind_contacts_title')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings_import.kind_contacts_desc')}
              </p>
            </button>
            <button
              type="button"
              onClick={() => {
                setKind('leads');
                reset();
              }}
              className={`rounded-lg border p-4 text-left transition ${
                kind === 'leads' ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
              }`}
            >
              <p className="font-semibold">{t('settings_import.kind_leads_title')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings_import.kind_leads_desc')}
              </p>
            </button>
          </div>
        </div>

        {/* Funnel destination (leads only) */}
        {kind === 'leads' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t('settings_import.funnel_dest')} *</Label>
              <Select
                value={funnelId}
                onValueChange={(v) => {
                  setFunnelId(v);
                  setDefaultStageId('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('settings_import.funnel_placeholder')} />
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
              <Label>{t('settings_import.default_stage')} *</Label>
              <Select value={defaultStageId} onValueChange={setDefaultStageId} disabled={!funnelId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      funnelId
                        ? t('settings_import.stage_placeholder_choose')
                        : t('settings_import.stage_placeholder_funnel_first')
                    }
                  />
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
                {t('settings_import.default_stage_hint')}
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
            <p className="font-semibold">{t('settings_import.upload_cta')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('settings_import.upload_hint')}</p>
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
                    {t('settings_import.file_meta', {
                      rows: rows.length.toLocaleString(localeFor(lang)),
                      cols: headers.length,
                    })}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={importing}>
                {t('settings_import.change_file')}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div>
              <h2 className="font-semibold">{t('settings_import.mapping_title')}</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings_import.mapping_hint')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1">
                    {t(f.label)}
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
                      <SelectItem value="none">{t('settings_import.dont_map')}</SelectItem>
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
            <h2 className="font-semibold">{t('settings_import.preview_title')}</h2>
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
              {t('settings_import.will_import', {
                rows: rows.length.toLocaleString(localeFor(lang)),
              })}
            </p>
            <Button onClick={commit} disabled={importing || rows.length === 0}>
              {importing ? (
                t('settings_import.importing')
              ) : (
                <>
                  {t('settings_import.import_now')}
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
            <h2 className="font-semibold">{t('settings_import.done_title')}</h2>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-emerald-600">{result.created}</p>
              <p className="text-xs text-muted-foreground">{t('settings_import.stat_created')}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-blue-600">{result.updated}</p>
              <p className="text-xs text-muted-foreground">{t('settings_import.stat_updated')}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold text-amber-600">{result.skipped}</p>
              <p className="text-xs text-muted-foreground">{t('settings_import.stat_skipped')}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-2xl font-bold">{result.labelsCreated}</p>
              <p className="text-xs text-muted-foreground">{t('settings_import.stat_labels')}</p>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                {t('settings_import.errors_header', { n: result.errors.length })}
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground max-h-48 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    {t('settings_import.error_row', { row: e.row, reason: e.reason })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={reset}>
            {t('settings_import.import_another')}
          </Button>
        </div>
      )}
    </div>
  );
}
