'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
  errors: Array<{ phoneNumber: string; reason: string }>;
}

interface ParsedRow {
  phoneNumber: string;
  name?: string;
  raw: string;
  error?: string;
}

const E164 = /^\+\d{8,15}$/;

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replaceAll('\r\n', '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    // Suporta vírgula ou ponto-e-vírgula como separador
    const sep = line.includes(';') && !line.includes(',') ? ';' : ',';
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === sep) {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]!).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/\D/g, '');
  if (!cleaned) return '';
  // Se não começa com +, assume +55 (Brasil) quando tiver 10-11 dígitos
  if (raw.startsWith('+')) return `+${cleaned}`;
  if (cleaned.length === 10 || cleaned.length === 11) return `+55${cleaned}`;
  if (cleaned.length === 12 || cleaned.length === 13) return `+${cleaned}`;
  return `+${cleaned}`;
}

export function ImportContactsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [filename, setFilename] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!open) {
      setParsedRows([]);
      setFilename('');
      setResult(null);
    }
  }, [open]);

  function handleFile(file: File) {
    setFilename(file.name);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result ?? '');
      const { headers, rows } = parseCsv(text);
      if (rows.length === 0) {
        toast.error(t('c_contacts_import_contacts_dialog.toast_empty_file'));
        return;
      }

      // Detecta colunas — aceita phoneNumber, phone, telefone, fone, número
      const phoneIdx = headers.findIndex((h) =>
        ['phonenumber', 'phone', 'telefone', 'fone', 'numero', 'número', 'celular', 'whatsapp'].includes(
          h,
        ),
      );
      const nameIdx = headers.findIndex((h) =>
        ['name', 'nome', 'contato', 'contact', 'fullname'].includes(h),
      );

      if (phoneIdx === -1) {
        toast.error(t('c_contacts_import_contacts_dialog.toast_no_phone_column'));
        return;
      }

      const parsed: ParsedRow[] = rows.map((cells) => {
        const rawPhone = cells[phoneIdx] ?? '';
        const phone = normalizePhone(rawPhone);
        const name = nameIdx >= 0 ? cells[nameIdx] : undefined;
        const valid = E164.test(phone);
        return {
          phoneNumber: phone,
          name: name ? name.trim() : undefined,
          raw: rawPhone,
          error: valid ? undefined : t('c_contacts_import_contacts_dialog.invalid_phone'),
        };
      });
      setParsedRows(parsed);
    };
    reader.readAsText(file);
  }

  async function submit() {
    const valid = parsedRows.filter((r) => !r.error);
    if (valid.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<ImportResult>('/api/contacts/import', {
        method: 'POST',
        body: JSON.stringify({
          contacts: valid.map((r) => ({ phoneNumber: r.phoneNumber, name: r.name ?? null })),
          skipDuplicates,
        }),
      });
      setResult(res);
      toast.success(t('c_contacts_import_contacts_dialog.toast_imported', { n: res.imported }));
      await qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_contacts_import_contacts_dialog.toast_import_error'));
    } finally {
      setSubmitting(false);
    }
  }

  function downloadTemplate() {
    const csv = 'phoneNumber,name\n+5511999999999,João Silva\n+5511888888888,Maria Santos\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = t('c_contacts_import_contacts_dialog.template_filename');
    a.click();
    URL.revokeObjectURL(url);
  }

  const validCount = parsedRows.filter((r) => !r.error).length;
  const invalidCount = parsedRows.length - validCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('c_contacts_import_contacts_dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('c_contacts_import_contacts_dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Result */}
          {result && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                <h3 className="font-semibold">{t('c_contacts_import_contacts_dialog.import_done')}</h3>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Stat label={t('c_contacts_import_contacts_dialog.stat_imported')} value={result.imported} color="text-emerald-700" />
                <Stat label={t('c_contacts_import_contacts_dialog.stat_skipped')} value={result.skipped} color="text-slate-600" />
                <Stat label={t('c_contacts_import_contacts_dialog.stat_total')} value={result.total} color="text-foreground" />
              </div>
              {result.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-destructive">
                    {t('c_contacts_import_contacts_dialog.errors_summary', { n: result.errors.length })}
                  </summary>
                  <ul className="mt-2 max-h-32 overflow-y-auto rounded-md border bg-background p-2 text-[11px]">
                    {result.errors.map((e, i) => (
                      <li key={i}>
                        <code>{e.phoneNumber}</code> — {e.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="flex justify-end pt-2">
                <Button size="sm" onClick={() => onOpenChange(false)}>
                  {t('action.close')}
                </Button>
              </div>
            </div>
          )}

          {/* Step 1: upload */}
          {!result && parsedRows.length === 0 && (
            <>
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) handleFile(f);
                }}
                className="cursor-pointer rounded-lg border-2 border-dashed bg-muted/20 px-6 py-10 text-center hover:bg-muted/40"
              >
                <FileSpreadsheet className="mx-auto h-10 w-10 text-muted-foreground" />
                <p className="mt-3 font-semibold">{t('c_contacts_import_contacts_dialog.dropzone')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('c_contacts_import_contacts_dialog.max_rows')}
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('c_contacts_import_contacts_dialog.need_example')}</span>
                <Button size="sm" variant="ghost" onClick={downloadTemplate}>
                  <Download className="h-3 w-3" />
                  {t('c_contacts_import_contacts_dialog.download_template')}
                </Button>
              </div>
            </>
          )}

          {/* Step 2: preview */}
          {!result && parsedRows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{filename}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setParsedRows([]);
                      setFilename('');
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
                    {t('c_contacts_import_contacts_dialog.valid_count', { n: validCount })}
                  </span>
                  {invalidCount > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
                      {t('c_contacts_import_contacts_dialog.invalid_count', { n: invalidCount })}
                    </span>
                  )}
                </div>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-2 py-1.5">{t('common.phone')}</th>
                      <th className="px-2 py-1.5">{t('common.name')}</th>
                      <th className="px-2 py-1.5">{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 100).map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 font-mono">{r.phoneNumber}</td>
                        <td className="px-2 py-1">{r.name ?? '—'}</td>
                        <td className="px-2 py-1">
                          {r.error ? (
                            <span className="inline-flex items-center gap-1 text-red-700">
                              <AlertCircle className="h-3 w-3" />
                              {r.error}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 className="h-3 w-3" />
                              {t('c_contacts_import_contacts_dialog.status_ok')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedRows.length > 100 && (
                  <p className="border-t bg-muted/30 p-2 text-center text-[11px] text-muted-foreground">
                    {t('c_contacts_import_contacts_dialog.showing_first', { total: parsedRows.length })}
                  </p>
                )}
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                />
                {t('c_contacts_import_contacts_dialog.skip_duplicates')}
              </label>

              <div className="flex justify-end gap-2 border-t pt-3">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {t('action.cancel')}
                </Button>
                <Button onClick={submit} disabled={submitting || validCount === 0}>
                  {submitting
                    ? t('c_contacts_import_contacts_dialog.importing')
                    : t('c_contacts_import_contacts_dialog.import_count', { n: validCount })}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

// import Upload icon for lint
void Upload;
