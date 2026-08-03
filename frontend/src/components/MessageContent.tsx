import { useMemo } from 'react';
import {
  looksLikeHtml,
  resolveContentDirection,
  type TextDirection,
} from '../utils/textDirection';
import './message-content.css';

export type MessageContentFormat = 'html' | 'text' | 'auto';

export interface MessageContentProps {
  /** Raw message body (plain text or HTML fragment). */
  content: string;
  /** Content type; `auto` detects HTML tags. */
  format?: MessageContentFormat;
  className?: string;
  /** Override detected direction (rare — prefer automatic detection). */
  dir?: TextDirection;
  lang?: string;
  as?: 'div' | 'span' | 'article';
}

/**
 * Unified BiDi-aware message renderer for Inbox, previews, drafts, and AI replies.
 * Uses CSS + dir attributes only — no string reversal.
 */
export default function MessageContent({
  content,
  format = 'auto',
  className = '',
  dir: dirOverride,
  lang: langOverride,
  as: Tag = 'div',
}: MessageContentProps) {
  const safeContent = String(content || '');
  const isHtml = format === 'html' || (format === 'auto' && looksLikeHtml(safeContent));

  const { dir, lang } = useMemo(() => {
    const resolved = resolveContentDirection(safeContent, isHtml ? 'html' : 'text');
    return {
      dir: dirOverride || resolved.dir,
      lang: langOverride || resolved.lang,
    };
  }, [safeContent, isHtml, dirOverride, langOverride]);

  const classNames = [
    'lf-message-content',
    isHtml ? 'lf-message-content--html' : 'lf-message-content--plain',
    className,
  ].filter(Boolean).join(' ');

  if (isHtml) {
    return (
      <Tag
        className={classNames}
        dir={dir}
        lang={lang}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: safeContent }}
      />
    );
  }

  return (
    <Tag className={classNames} dir={dir} lang={lang}>
      {safeContent}
    </Tag>
  );
}

/** Textarea/input wrapper with dir="auto" + plaintext bidi for compose areas. */
export function BidiTextArea({
  className = '',
  multiline = true,
  dir = 'auto',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline?: boolean }) {
  return (
    <textarea
      {...props}
      dir={dir}
      className={[
        'lf-bidi-field',
        multiline ? 'lf-bidi-field--multiline' : '',
        className,
      ].filter(Boolean).join(' ')}
    />
  );
}

export function BidiInput({
  className = '',
  dir = 'auto',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      dir={dir}
      className={['lf-bidi-field', className].filter(Boolean).join(' ')}
    />
  );
}
