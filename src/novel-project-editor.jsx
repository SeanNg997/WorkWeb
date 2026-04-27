import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, EditorRoot, StarterKit, Placeholder, useEditor } from 'novel';
import Image from '@tiptap/extension-image';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

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

function imageAttrsToHtml(attrs = {}) {
  const safeSrc = String(attrs.src || '').replace(/"/g, '&quot;');
  const safeAlt = String(attrs.alt || '').replace(/"/g, '&quot;');
  const width = attrs.width ? ` style="width:${String(attrs.width).replace(/"/g, '&quot;')};height:auto;"` : '';
  return `<img src="${safeSrc}" alt="${safeAlt}"${width}>`;
}

function NovelToolbar({ sourceMode, onToggleSourceMode, showSourceToggle = true, saveStatus, onImageUpload }) {
  const { editor } = useEditor();
  const fileInputRef = useRef(null);
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

  async function handleImageFile(file) {
    if (!file || !onImageUpload) return;
    const attrs = await onImageUpload(file);
    editor.chain().focus().insertContent(imageAttrsToHtml(attrs)).run();
  }

  return (
    <div className="novel-toolbar">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={event => {
          handleImageFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
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
      {onImageUpload ? (
        <ToolbarButton title="插入图片" active={false} onClick={() => fileInputRef.current?.click()}>图片</ToolbarButton>
      ) : null}
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

function EditorReadyBridge({ onReady }) {
  const { editor } = useEditor();

  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  return null;
}

function NovelProjectEditor({
  value,
  onChange,
  placeholder,
  sourceMode,
  onToggleSourceMode,
  showToolbar = true,
  showSourceToggle = true,
  saveStatus = null,
  onImageUpload,
  onEditorReady
}) {
  const initialContent = useMemo(() => markdownToHtml(value), []);

  const extensions = useMemo(() => [
    StarterKit,
    Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: {
            default: null,
            parseHTML: element => element.style.width || element.getAttribute('width'),
            renderHTML: attributes => attributes.width
              ? { style: `width:${attributes.width};height:auto;` }
              : {}
          }
        };
      }
    }).configure({ inline: false, allowBase64: false }),
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

  async function insertUploadedImage(view, file) {
    if (!onImageUpload) return;
    const attrs = await onImageUpload(file);
    const node = view.state.schema.nodes.image.create(attrs);
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
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
        handleClick: (view, _pos, event) => focusEndWhenClickingBlankSpace(view, event),
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
          if (!files.length || !onImageUpload) return false;
          event.preventDefault();
          files.forEach(file => insertUploadedImage(view, file));
          return true;
        }
      }}
      slotBefore={showToolbar ? (
        <>
          <EditorReadyBridge onReady={onEditorReady} />
          <NovelToolbar
            sourceMode={sourceMode}
            onToggleSourceMode={onToggleSourceMode}
            showSourceToggle={showSourceToggle}
            saveStatus={saveStatus}
            onImageUpload={onImageUpload}
          />
        </>
      ) : null}
      slotAfter={!showToolbar ? <EditorReadyBridge onReady={onEditorReady} /> : null}
      onUpdate={({ editor }) => onChange?.(editor.getHTML())}
      />
    </EditorRoot>
  );
}

function isBlankSpaceClick(host, event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;

  const content = host.querySelector('.novel-project-editor-content');
  const prose = host.querySelector('.novel-project-editor-prose');
  if (!content || !prose || !content.contains(target)) return false;
  if (target.closest('.novel-toolbar')) return false;

  const lastBlock = Array.from(prose.children).at(-1);
  if (!lastBlock) return true;
  return event.clientY > lastBlock.getBoundingClientRect().bottom;
}

function focusEditorEnd(editor, host) {
  if (editor?.chain) {
    editor.chain().focus('end').run();
    return;
  }

  const prose = host.querySelector('[contenteditable="true"]');
  if (!prose) return;
  prose.focus();
  const range = document.createRange();
  range.selectNodeContents(prose);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectDomText(host, query, occurrenceIndex = 0) {
  const prose = host.querySelector('.novel-project-editor-prose');
  if (!prose || !query) return false;

  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node = walker.nextNode();
  while (node) {
    parts.push({ node, start: parts.reduce((sum, part) => sum + part.node.nodeValue.length, 0) });
    node = walker.nextNode();
  }

  const text = parts.map(part => part.node.nodeValue).join('');
  const needle = query.toLowerCase();
  let index = -1;
  for (let i = 0; i <= occurrenceIndex; i++) {
    index = text.toLowerCase().indexOf(needle, index + 1);
    if (index < 0) return false;
  }

  const startPart = parts.find(part => index >= part.start && index <= part.start + part.node.nodeValue.length);
  const endIndex = index + query.length;
  const endPart = parts.find(part => endIndex >= part.start && endIndex <= part.start + part.node.nodeValue.length);
  if (!startPart || !endPart) return false;

  const range = document.createRange();
  range.setStart(startPart.node, index - startPart.start);
  range.setEnd(endPart.node, endIndex - endPart.start);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  prose.focus();
  range.getBoundingClientRect && prose.parentElement?.scrollTo({
    top: prose.parentElement.scrollTop + range.getBoundingClientRect().top - prose.parentElement.getBoundingClientRect().top - 80,
    behavior: 'smooth'
  });
  return true;
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
    onImageUpload: options.onImageUpload,
    editor: null,
    version: 0
  };

  function handleHostMouseDown(event) {
    if (!isBlankSpaceClick(el, event)) return;
    event.preventDefault();
    focusEditorEnd(state.editor, el);
  }

  function handleImagePointerDown(event) {
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img || event.button !== 0 || !state.editor?.view) return;
    const rect = img.getBoundingClientRect();
    if (event.clientX < rect.right - 16 && event.clientY < rect.bottom - 16) return;

    event.preventDefault();
    const prose = el.querySelector('.novel-project-editor-prose');
    const editorWidth = prose?.clientWidth || rect.width;
    const startX = event.clientX;
    const startWidth = rect.width;
    const pos = state.editor.view.posAtDOM(img, 0);

    function handleMove(moveEvent) {
      const nextWidth = Math.max(80, Math.min(editorWidth, startWidth + moveEvent.clientX - startX));
      img.style.width = `${Math.round((nextWidth / editorWidth) * 100)}%`;
      img.style.height = 'auto';
    }

    function handleUp() {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      const width = img.style.width || null;
      if (Number.isFinite(pos) && width) {
        const { view } = state.editor;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        state.editor.commands.updateAttributes('image', { width });
      }
    }

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp, { once: true });
  }

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
        onImageUpload={state.onImageUpload}
        onEditorReady={editor => { state.editor = editor; }}
      />
    );
  }

  render();
  el.addEventListener('mousedown', handleHostMouseDown);
  el.addEventListener('pointerdown', handleImagePointerDown, true);

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
    focusEnd() {
      focusEditorEnd(state.editor, el);
    },
    selectText(query, occurrenceIndex = 0) {
      return selectDomText(el, query, occurrenceIndex);
    },
    destroy() {
      el.removeEventListener('mousedown', handleHostMouseDown);
      el.removeEventListener('pointerdown', handleImagePointerDown, true);
      root.unmount();
      mountedEditors.delete(el);
    }
  };

  mountedEditors.set(el, { root, api });
  return api;
}

window.mountNovelProjectEditor = mountNovelProjectEditor;
