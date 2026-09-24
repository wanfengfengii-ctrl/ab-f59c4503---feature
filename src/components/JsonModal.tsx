import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  mode: 'import' | 'export';
  initialText: string;
  errors: string[];
  onClose: () => void;
  onImport: (text: string) => void;
}

export function JsonModal({ open, mode, initialText, errors, onClose, onImport }: Props) {
  const [text, setText] = useState(initialText);
  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'import' ? '导入模型 JSON' : '导出模型 JSON'}</h2>
        <textarea
          data-testid="json-textarea"
          spellCheck={false}
          value={text}
          readOnly={mode === 'export'}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"places":[...],"transitions":[...],"forbidden":[...]}'
        />
        {errors.length > 0 && (
          <div className="json-errors" data-testid="json-errors">
            {errors.map((e, i) => (
              <div key={i}>• {e}</div>
            ))}
          </div>
        )}
        <div className="row end">
          <button className="secondary" data-testid="json-cancel" onClick={onClose}>
            关闭
          </button>
          {mode === 'import' && (
            <button className="primary" data-testid="json-confirm" onClick={() => onImport(text)}>
              校验并导入
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
