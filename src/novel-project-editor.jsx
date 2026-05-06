import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, EditorRoot, StarterKit, Placeholder, useEditor } from 'novel';
import { Extension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import { NodeSelection, TextSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const mountedEditors = new Map();
const IMAGE_RESIZE_HOTSPOT_SIZE = 16;
const AI_PLUGIN_KEY = new PluginKey('aiCompletion');

function createAICompletionExtension() {
  let debounceTimer = null;
  let pendingSuggestion = '';
  let isLoading = false;

  function clearSuggestion(view) {
    pendingSuggestion = '';
    isLoading = false;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: '', loading: false }));
  }

  function showSuggestion(view, text) {
    pendingSuggestion = text;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: text, loading: false }));
  }

  function setLoadingState(view, loading) {
    isLoading = loading;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: pendingSuggestion, loading }));
  }

  function extractContext(view) {
    const { state } = view;
    const { selection } = state;
    const cursorPos = selection.$head;
    const before = state.doc.textBetween(Math.max(0, cursorPos.pos - 600), cursorPos.pos, '\n');
    const currentBlock = cursorPos.parent;
    
    // 提取文档标题（第一个标题节点）
    let docTitle = '';
    state.doc.descendants((node) => {
      if (!docTitle && node.type.name === 'heading') {
        docTitle = node.textContent;
      }
      return !docTitle;
    });
    
    // 提取文档摘要（前500字符）
    const fullText = state.doc.textContent;
    const summary = fullText.slice(0, 500);
    
    return { 
      beforeText: before, 
      currentText: currentBlock.textContent,
      docTitle,
      summary
    };
  }

  async function requestCompletion(view) {
    const config = window.__aiConfig;
    if (!config?.enabled || !config?.apiKey || !config?.baseUrl || !config?.model) return;

    const { beforeText, currentText, docTitle, summary } = extractContext(view);
    if (!beforeText.trim() && !currentText.trim()) return;

    setLoadingState(view, true);

    const prompt = [
      '你是一个 Markdown 写作助手，负责根据上下文续写内容。',
      '',
      '要求：',
      '- 保持与原文风格、语气、格式一致',
      '- 不要重复已有内容',
      '- 直接输出续写部分，不要加任何解释或前缀',
      '- 如果上下文是列表或分点内容，继续以相同格式输出',
      '- 只续写一小段（1-3句话或1-2个列表项），保持简洁',
      '',
      docTitle ? `文档标题：${docTitle}` : '',
      summary ? `文档摘要：${summary.slice(0, 300)}` : '',
      '',
      '前文内容：',
      beforeText.slice(-400),
      currentText ? `\n当前段落：${currentText}` : '',
      '',
      '请简洁续写：'
    ].filter(Boolean).join('\n');

    try {
      const res = await fetch('/api/ai/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: config.protocol,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          prompt,
          maxTokens: 60
        })
      });
      const data = await res.json();
      if (data.text) {
        showSuggestion(view, data.text.replace(/^\n+/, ''));
      } else {
        clearSuggestion(view);
      }
    } catch {
      clearSuggestion(view);
    }
  }

  function scheduleCompletion(view) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => requestCompletion(view), 500);
  }

  return Extension.create({
    name: 'aiCompletion',

    addKeyboardShortcuts() {
      return {
        Tab: ({ editor }) => {
          if (!pendingSuggestion) return false;
          const { view } = editor;
          const tr = view.state.tr.insertText(pendingSuggestion);
          view.dispatch(tr);
          clearSuggestion(view);
          return true;
        },
        Escape: ({ editor }) => {
          if (!pendingSuggestion && !isLoading) return false;
          clearSuggestion(editor.view);
          return true;
        }
      };
    },

    onUpdate({ editor }) {
      const config = window.__aiConfig;
      if (!config?.enabled) return;
      scheduleCompletion(editor.view);
    },

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: AI_PLUGIN_KEY,
          state: {
            init() { return { suggestion: '', loading: false }; },
            apply(tr, prev) {
              const meta = tr.getMeta(AI_PLUGIN_KEY);
              return meta || prev;
            }
          },
          props: {
            decorations(state) {
              const { suggestion, loading } = this.getState(state);
              if (!suggestion && !loading) return DecorationSet.empty;
              const { selection } = state;
              const pos = selection.$to.pos;
              const text = loading ? ' 生成中...' : suggestion;
              if (!text) return DecorationSet.empty;
              const deco = Decoration.widget(pos, () => {
                const span = document.createElement('span');
                span.className = 'ai-completion-ghost';
                span.textContent = text;
                return span;
              }, { side: 1, ignoreSelection: true });
              return DecorationSet.create(state.doc, [deco]);
            },
            handleClick(view) {
              if (pendingSuggestion || isLoading) {
                clearSuggestion(view);
              }
              return false;
            }
          }
        })
      ];
    }
  });
}

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
  const aiEnabled = window.__aiConfig?.enabled || false;

  async function handleImageFile(file) {
    if (!file || !onImageUpload) return;
    const attrs = await onImageUpload(file);
    editor.chain().focus().insertContent(imageAttrsToHtml(attrs)).run();
  }

  function toggleAI() {
    const config = window.__aiConfig || {};
    const newConfig = { ...config, enabled: !config.enabled };
    window.__aiConfig = newConfig;
    if (typeof window.__onAIToggle === 'function') window.__onAIToggle(newConfig);
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
      <ToolbarButton title="下划线" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></ToolbarButton>
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
      <ToolbarButton title={aiEnabled ? '关闭自动补全' : '开启自动补全'} active={aiEnabled} onClick={toggleAI}>自动补全</ToolbarButton>
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
  onEditorReady,
  aiConfig
}) {
  const initialContent = useMemo(() => markdownToHtml(value), []);

  useEffect(() => {
    window.__aiConfig = aiConfig || {};
    return () => { window.__aiConfig = {}; };
  }, [aiConfig]);

  const aiExtension = useMemo(() => createAICompletionExtension(), []);

  const extensions = useMemo(() => [
    StarterKit,
    Underline,
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
    }),
    aiExtension
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

function scrollRangeIntoProseView(prose, range) {
  const rangeRect = range.getBoundingClientRect?.();
  if (!rangeRect) return;

  const proseRect = prose.getBoundingClientRect();
  const targetTop = prose.scrollTop + rangeRect.top - proseRect.top - 80;
  const maxScrollTop = Math.max(0, prose.scrollHeight - prose.clientHeight);
  prose.scrollTo({
    top: Math.max(0, Math.min(maxScrollTop, targetTop)),
    behavior: 'smooth'
  });
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
  scrollRangeIntoProseView(prose, range);
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
    aiConfig: options.aiConfig || null,
    editor: null,
    version: 0
  };
  let resizeReadyImage = null;

  function handleHostMouseDown(event) {
    if (!isBlankSpaceClick(el, event)) return;
    event.preventDefault();
    focusEditorEnd(state.editor, el);
  }

  function isResizeHandleHit(event, rect) {
    return event.clientX >= rect.right - IMAGE_RESIZE_HOTSPOT_SIZE
      && event.clientY >= rect.bottom - IMAGE_RESIZE_HOTSPOT_SIZE;
  }

  function setResizeReadyImage(nextImage) {
    if (resizeReadyImage && resizeReadyImage !== nextImage) {
      resizeReadyImage.classList.remove('resize-ready');
    }
    resizeReadyImage = nextImage || null;
    resizeReadyImage?.classList.add('resize-ready');
  }

  function handleImagePointerMove(event) {
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img) {
      setResizeReadyImage(null);
      return;
    }
    setResizeReadyImage(isResizeHandleHit(event, img.getBoundingClientRect()) ? img : null);
  }

  function clearImageResizeReady() {
    setResizeReadyImage(null);
  }

  function handleImagePointerDown(event) {
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img || event.button !== 0 || !state.editor?.view) return;
    const rect = img.getBoundingClientRect();
    if (!isResizeHandleHit(event, rect)) return;

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
        aiConfig={state.aiConfig}
      />
    );
  }

  render();
  el.addEventListener('mousedown', handleHostMouseDown);
  el.addEventListener('pointermove', handleImagePointerMove, true);
  el.addEventListener('pointerdown', handleImagePointerDown, true);
  el.addEventListener('pointerleave', clearImageResizeReady, true);

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
    setAIConfig(nextConfig) {
      state.aiConfig = nextConfig || null;
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
      el.removeEventListener('pointermove', handleImagePointerMove, true);
      el.removeEventListener('pointerdown', handleImagePointerDown, true);
      el.removeEventListener('pointerleave', clearImageResizeReady, true);
      clearImageResizeReady();
      root.unmount();
      mountedEditors.delete(el);
    }
  };

  mountedEditors.set(el, { root, api });
  return api;
}

window.mountNovelProjectEditor = mountNovelProjectEditor;
