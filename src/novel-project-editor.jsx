import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, EditorRoot, StarterKit, Placeholder, useEditor } from 'novel';

const mountedEditors = new Map();

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(value || '');
}

function markdownToHtml(value) {
  if (!value) return '';
  if (looksLikeHtml(value)) return value;
  if (window.marked?.parse) return window.marked.parse(value, { breaks: true });
  return value
    .split('\n')
    .map(line => `<p>${line.replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]))}</p>`)
    .join('');
}

function ToolbarButton({ active, children, onClick, title }) {
  return (
    <button
      type="button"
      className={`novel-toolbar-button${active ? ' active' : ''}`}
      title={title}
      onMouseDown={event => {
        event.preventDefault();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function NovelToolbar() {
  const { editor } = useEditor();
  const tick = useSyncExternalStore(
    callback => {
      if (!editor) return () => {};
      editor.on('selectionUpdate', callback);
      editor.on('transaction', callback);
      editor.on('update', callback);
      return () => {
        editor.off('selectionUpdate', callback);
        editor.off('transaction', callback);
        editor.off('update', callback);
      };
    },
    () => Date.now(),
    () => 0
  );

  if (!editor) return null;
  void tick;

  return (
    <div className="novel-toolbar">
      <ToolbarButton title="一级标题" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</ToolbarButton>
      <ToolbarButton title="二级标题" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</ToolbarButton>
      <ToolbarButton title="正文" active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>正文</ToolbarButton>
      <ToolbarButton title="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></ToolbarButton>
      <ToolbarButton title="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></ToolbarButton>
      <ToolbarButton title="删除线" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolbarButton>
      <ToolbarButton title="项目列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>• 列表</ToolbarButton>
      <ToolbarButton title="编号列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. 列表</ToolbarButton>
      <ToolbarButton title="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>引用</ToolbarButton>
      <ToolbarButton title="代码块" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'{ }'}</ToolbarButton>
    </div>
  );
}

function NovelProjectEditor({ value, onChange, placeholder }) {
  const initialContent = useMemo(() => markdownToHtml(value), []);

  const extensions = useMemo(() => [
    StarterKit,
    Placeholder.configure({
      placeholder: placeholder || '输入项目内容...'
    })
  ], [placeholder]);

  useEffect(() => {
    return () => {};
  }, [value]);

  return (
    <EditorRoot>
      <EditorContent
        className="novel-project-editor-content"
        immediatelyRender={false}
        initialContent={initialContent}
        extensions={extensions}
      editorProps={{
        attributes: {
          class: 'novel-project-editor-prose'
        }
      }}
      slotBefore={<NovelToolbar />}
      onUpdate={({ editor }) => onChange?.(editor.getHTML())}
      />
    </EditorRoot>
  );
}

function mountNovelProjectEditor(el, options = {}) {
  if (!el) return null;

  const existing = mountedEditors.get(el);
  if (existing) {
    existing.root.unmount();
    mountedEditors.delete(el);
  }

  const root = createRoot(el);
  const state = {
    value: options.value || '',
    onChange: options.onChange,
    placeholder: options.placeholder,
    version: 0
  };

  function render() {
    root.render(
      <NovelProjectEditor
        key={state.version}
        value={state.value}
        onChange={state.onChange}
        placeholder={state.placeholder}
      />
    );
  }

  render();

  const api = {
    setValue(nextValue) {
      state.value = nextValue || '';
      state.version += 1;
      render();
    },
    focus() {
      el.querySelector('[contenteditable="true"]')?.focus();
    },
    destroy() {
      root.unmount();
      mountedEditors.delete(el);
    }
  };

  mountedEditors.set(el, { root, api });
  return api;
}

window.mountNovelProjectEditor = mountNovelProjectEditor;
