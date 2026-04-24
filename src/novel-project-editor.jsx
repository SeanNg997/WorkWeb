import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, EditorRoot, StarterKit, Placeholder, useEditor } from 'novel';
import { TextSelection } from '@tiptap/pm/state';

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

function ToolbarDropdown({ active, items, label, title }) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef(null);

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openMenu() {
    clearCloseTimer();
    setOpen(true);
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 300);
  }

  function toggleMenu() {
    clearCloseTimer();
    setOpen(current => !current);
  }

  function handleItemClick(action) {
    action();
    clearCloseTimer();
    setOpen(false);
  }

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div
      className={`novel-toolbar-group${open ? ' open' : ''}`}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`novel-toolbar-button novel-toolbar-trigger${active ? ' active' : ''}${open ? ' open' : ''}`}
        title={title}
        onMouseDown={event => event.preventDefault()}
        onClick={toggleMenu}
      >
        <span>{label}</span>
        <span className="novel-toolbar-caret" aria-hidden="true">▾</span>
      </button>
      <div className={`novel-toolbar-menu${open ? ' open' : ''}`}>
        {items.map(item => (
          <ToolbarButton
            key={item.key}
            title={item.title}
            active={item.active}
            onClick={() => handleItemClick(item.onClick)}
          >
            {item.label}
          </ToolbarButton>
        ))}
      </div>
    </div>
  );
}

function NovelToolbar({ sourceMode, onToggleSourceMode, showSourceToggle = true, saveStatus }) {
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

  const headingActive = [1, 2, 3, 4].some(level => editor.isActive('heading', { level }));
  const listActive = editor.isActive('bulletList') || editor.isActive('orderedList');

  return (
    <div className="novel-toolbar">
      <ToolbarDropdown
        title="标题等级"
        label="标题"
        active={headingActive}
        items={[
          {
            key: 'heading-1',
            title: '一级标题',
            label: 'H1 一级标题',
            active: editor.isActive('heading', { level: 1 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run()
          },
          {
            key: 'heading-2',
            title: '二级标题',
            label: 'H2 二级标题',
            active: editor.isActive('heading', { level: 2 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run()
          },
          {
            key: 'heading-3',
            title: '三级标题',
            label: 'H3 三级标题',
            active: editor.isActive('heading', { level: 3 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run()
          },
          {
            key: 'heading-4',
            title: '四级标题',
            label: 'H4 四级标题',
            active: editor.isActive('heading', { level: 4 }),
            onClick: () => editor.chain().focus().toggleHeading({ level: 4 }).run()
          }
        ]}
      />
      <ToolbarButton title="正文" active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>正文</ToolbarButton>
      <ToolbarButton title="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></ToolbarButton>
      <ToolbarButton title="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></ToolbarButton>
      <ToolbarButton title="删除线" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolbarButton>
      <ToolbarDropdown
        title="列表"
        label="列表"
        active={listActive}
        items={[
          {
            key: 'bullet-list',
            title: '无序列表',
            label: '• 无序列表',
            active: editor.isActive('bulletList'),
            onClick: () => editor.chain().focus().toggleBulletList().run()
          },
          {
            key: 'ordered-list',
            title: '有序列表',
            label: '1. 有序列表',
            active: editor.isActive('orderedList'),
            onClick: () => editor.chain().focus().toggleOrderedList().run()
          }
        ]}
      />
      <ToolbarButton title="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>引用</ToolbarButton>
      <ToolbarButton title="代码块" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'{ }'}</ToolbarButton>
      {showSourceToggle ? (
        <ToolbarButton title={sourceMode ? '返回可视编辑' : '切换源码模式'} active={sourceMode} onClick={() => onToggleSourceMode?.()}>源代码</ToolbarButton>
      ) : null}
      <div className="novel-toolbar-spacer" />
      <span
        className={`novel-save-status${saveStatus?.visible ? ' visible' : ''}${saveStatus?.tone ? ` ${saveStatus.tone}` : ''}`}
        aria-live="polite"
      >
        {saveStatus?.text || ''}
      </span>
    </div>
  );
}

function NovelProjectEditor({
  value,
  onChange,
  placeholder,
  sourceMode,
  onToggleSourceMode,
  showToolbar = true,
  showSourceToggle = true,
  saveStatus = null
}) {
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

  function focusEndWhenClickingBlankSpace(view, event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;

    const prose = target.closest('.novel-project-editor-prose');
    if (!prose || target !== prose) return false;

    const lastBlock = Array.from(prose.children).at(-1);
    if (!lastBlock || event.clientY <= lastBlock.getBoundingClientRect().bottom) return false;

    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.focus();
    return true;
  }

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
        },
        handleClick: (view, _pos, event) => focusEndWhenClickingBlankSpace(view, event)
      }}
      slotBefore={showToolbar ? (
        <NovelToolbar
          sourceMode={sourceMode}
          onToggleSourceMode={onToggleSourceMode}
          showSourceToggle={showSourceToggle}
          saveStatus={saveStatus}
        />
      ) : null}
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
    sourceMode: Boolean(options.sourceMode),
    onToggleSourceMode: options.onToggleSourceMode,
    showToolbar: options.showToolbar !== false,
    showSourceToggle: options.showSourceToggle !== false,
    saveStatus: options.saveStatus || null,
    version: 0
  };

  function render() {
    root.render(
      <NovelProjectEditor
        key={state.version}
        value={state.value}
        onChange={state.onChange}
        placeholder={state.placeholder}
        sourceMode={state.sourceMode}
        onToggleSourceMode={state.onToggleSourceMode}
        showToolbar={state.showToolbar}
        showSourceToggle={state.showSourceToggle}
        saveStatus={state.saveStatus}
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
    setSourceMode(nextMode) {
      state.sourceMode = Boolean(nextMode);
      state.version += 1;
      render();
    },
    setSaveStatus(nextStatus) {
      state.saveStatus = nextStatus || null;
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
