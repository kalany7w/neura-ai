'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react';

export type MentionTarget = {
  userId: string;
  slug: string;
  name: string | null;
  email: string;
  image: string | null;
};

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (next: string) => void;
  targets: MentionTarget[];
  /**
   * Disparado quando Enter é pressionado SEM Shift e o picker NÃO está aberto.
   * Útil pra Cmd+Enter handlers no parent — eles chamam preventDefault e o submit.
   * Pra Cmd+Enter use `onKeyDown` padrão.
   */
}

export interface MentionTextareaHandle {
  focus: () => void;
  blur: () => void;
}

/**
 * Textarea com typeahead picker: ao digitar "@" + char, mostra dropdown
 * com members do workspace filtrados pela query. ↑/↓ navega, Tab/Enter insere,
 * Esc fecha. Picker aberto SUPRIME Enter pra evitar submit acidental.
 */
export const MentionTextarea = forwardRef<MentionTextareaHandle, Props>(function MentionTextarea(
  { value, onChange, targets, onKeyDown, ...rest },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerStart, setPickerStart] = useState(0); // offset do @
  const [activeIdx, setActiveIdx] = useState(0);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
  }));

  const filtered = pickerOpen
    ? targets
        .filter((t) => {
          const q = pickerQuery.toLowerCase();
          if (!q) return true;
          return (
            t.slug.toLowerCase().startsWith(q) ||
            (t.name?.toLowerCase() ?? '').includes(q) ||
            t.email.toLowerCase().startsWith(q)
          );
        })
        .slice(0, 6)
    : [];

  // Reseta active quando lista muda
  useEffect(() => {
    setActiveIdx(0);
  }, [pickerQuery, pickerOpen]);

  const detectMention = useCallback((next: string, caret: number) => {
    // Procura "@" mais próximo do caret, sem espaço entre ele e o caret
    let i = caret - 1;
    while (i >= 0) {
      const ch = next[i];
      if (ch === '@') {
        const before = i === 0 ? ' ' : (next[i - 1] ?? ' ');
        if (/[\s\n(]/.test(before)) {
          const query = next.slice(i + 1, caret);
          if (/^[a-z0-9_.]*$/i.test(query) && query.length <= 32) {
            setPickerOpen(true);
            setPickerQuery(query.toLowerCase());
            setPickerStart(i);
            return;
          }
        }
        break;
      }
      if (!ch || /\s/.test(ch)) break;
      i -= 1;
    }
    setPickerOpen(false);
    setPickerQuery('');
  }, []);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    detectMention(next, e.target.selectionStart);
  }

  function insertMention(target: MentionTarget) {
    const before = value.slice(0, pickerStart);
    const after = value.slice(textareaRef.current?.selectionStart ?? pickerStart);
    const inserted = `@${target.slug} `;
    const next = before + inserted + after;
    onChange(next);
    setPickerOpen(false);
    setPickerQuery('');
    // Reposiciona caret após o slug inserido
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = before.length + inserted.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = filtered[activeIdx];
        if (pick) insertMention(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerOpen(false);
        return;
      }
    }
    onKeyDown?.(e);
  }

  function handleSelect() {
    if (!textareaRef.current) return;
    detectMention(value, textareaRef.current.selectionStart);
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onBlur={() => setTimeout(() => setPickerOpen(false), 120)}
        {...rest}
      />
      {pickerOpen && filtered.length > 0 && (
        <div
          role="listbox"
          aria-label="Mencionar agente"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-lg"
        >
          {filtered.map((t, idx) => {
            const isActive = idx === activeIdx;
            const display = t.name?.trim() || t.email;
            return (
              <button
                key={t.userId}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  // Previne blur antes do click
                  e.preventDefault();
                  insertMention(t);
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                  isActive ? 'bg-accent' : ''
                }`}
              >
                {t.image ? (
                  <img src={t.image} alt={display} className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                    {(display[0] ?? '?').toUpperCase()}
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{display}</span>
                  <span className="truncate text-[11px] text-muted-foreground">@{t.slug}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
