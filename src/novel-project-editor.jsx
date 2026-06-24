import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, EditorRoot, StarterKit, Placeholder, useEditor } from 'novel';
import { Extension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import { NodeSelection, TextSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const mountedEditors = new Map();
const IMAGE_RESIZE_HOTSPOT_SIZE = 16;
const AI_CONTEXT_CHAR_LIMIT = 600;
const AI_NO_COMPLETION = '__NO_COMPLETION__';
const AI_PLUGIN_KEY = new PluginKey('aiCompletion');

function createAICompletionExtension(getAIConfig) {
  let debounceTimer = null;
  let pendingSuggestion = '';
  let isLoading = false;
  let requestVersion = 0;

  function clearSuggestion(view) {
    requestVersion += 1;
    clearTimeout(debounceTimer);
    pendingSuggestion = '';
    isLoading = false;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: '', loading: false }));
  }

  function showSuggestion(view, text) {
    pendingSuggestion = text;
    isLoading = false;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: text, loading: false }));
  }

  function setLoadingState(view, loading) {
    isLoading = loading;
    view.dispatch(view.state.tr.setMeta(AI_PLUGIN_KEY, { suggestion: pendingSuggestion, loading }));
  }

  function normalizeCompletionText(text) {
    const value = String(text || '').replace(/^\n+/, '').trimEnd();
    if (!value.trim() || value.trim() === AI_NO_COMPLETION) return '';
    return value;
  }

  function describeCursorStructure(cursorPos) {
    const labels = new Set();

    for (let depth = 0; depth <= cursorPos.depth; depth += 1) {
      const nodeName = cursorPos.node(depth).type.name;
      if (nodeName === 'heading') labels.add('Markdown 标题');
      if (nodeName === 'bulletList') labels.add('无序列表');
      if (nodeName === 'orderedList') labels.add('有序列表');
      if (nodeName === 'listItem') labels.add('列表项');
      if (nodeName === 'codeBlock') labels.add('代码块');
      if (nodeName === 'blockquote') labels.add('引用');
    }

    return Array.from(labels).join(' / ') || '普通段落';
  }

  function extractContext(view) {
    const { state } = view;
    const { selection } = state;
    const cursorPos = selection.$head;
    const before = state.doc.textBetween(Math.max(0, cursorPos.pos - AI_CONTEXT_CHAR_LIMIT), cursorPos.pos, '\n');
    const after = state.doc.textBetween(cursorPos.pos, Math.min(state.doc.content.size, cursorPos.pos + AI_CONTEXT_CHAR_LIMIT), '\n');
    const currentBlock = cursorPos.parent;

    return { 
      beforeText: before, 
      afterText: after,
      currentText: currentBlock.textBetween(0, cursorPos.parentOffset),
      cursorStructure: describeCursorStructure(cursorPos)
    };
  }

  async function requestCompletion(view) {
    const config = getAIConfig();
    if (!config?.enabled || !config?.apiKey || !config?.baseUrl || !config?.model) return;

    const { beforeText, afterText, currentText, cursorStructure } = extractContext(view);
    if (!beforeText.trim() && !currentText.trim()) return;

    const requestId = requestVersion + 1;
    requestVersion = requestId;
    setLoadingState(view, true);

    const projectTitle = String(config.projectTitle || '').trim();
    const projectSummary = String(config.projectSummary || '').trim();

    const cursor = currentText || '(段落开头)';

    const prompt = `你是科研项目笔记软件中的行内补全引擎。

你的唯一任务，是预测“光标处应该插入的一小段文本”，让用户可以直接插入原文。

请按以下优先级工作：
1. 严格延续当前项目主题、术语和论证方向，只补当前局部，不扩展成新话题。
2. 严格匹配上下文的语言、语气、信息密度与格式。
3. 如果当前句子未完成，优先把它自然补完；如果当前句子已完成，只补一个紧接其后的高价值短句、短语或单个列表项。
4. 如果当前处于 Markdown 标题、列表、表格、LaTeX 公式、代码块或引用中，优先保持该结构正确。
5. 科研笔记场景下，不要凭空引入未经上下文支持的新事实、数据、结论、引用或参考文献。
6. 只输出应插入的文本本身；不要解释，不要总结，不要加引号，不要加标题，不要输出任何元说明。
7. 不要重复已经出现在局部上下文中的内容，也不要复述项目标题或项目摘要。
8. 如果没有高质量补全，精确输出：${AI_NO_COMPLETION}

补全文本应满足：
- 可直接插入光标处
- 默认尽量短
- 最多一句
- 如果当前在列表、公式或代码中，可以输出一个列表项、一行公式或一行代码

[项目标题]
${projectTitle || '(未提供)'}
[/项目标题]

[项目摘要]
${projectSummary || '(未提供)'}
[/项目摘要]

[光标前最近内容]
${beforeText.slice(-AI_CONTEXT_CHAR_LIMIT)}
[/光标前最近内容]

[光标后最近内容]
${afterText.slice(0, AI_CONTEXT_CHAR_LIMIT) || '(未提供)'}
[/光标后最近内容]

[当前位置结构]
${cursorStructure}
[/当前位置结构]

[当前段落已输入]
${cursor}
[/当前段落已输入]

现在输出可直接插入光标处的补全文字；若无高质量结果，只输出 ${AI_NO_COMPLETION} 。`;

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
      if (requestId !== requestVersion || !getAIConfig()?.enabled) return;
      const suggestion = normalizeCompletionText(data.text);
      if (suggestion) {
        showSuggestion(view, suggestion);
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

    addCommands() {
      return {
        clearAICompletion: () => ({ editor }) => {
          clearSuggestion(editor.view);
          return true;
        }
      };
    },

    onUpdate({ editor }) {
      const config = getAIConfig();
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
            },
            handleKeyDown(view, event) {
              if (event.key === 'Tab' || event.key === 'Escape') return false;
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

function isClickBelowLastBlock(prose, event, emptyResult = false) {
  const lastBlock = Array.from(prose.children).at(-1);
  if (!lastBlock) return emptyResult;
  return event.clientY > lastBlock.getBoundingClientRect().bottom;
}

function NovelToolbar({ sourceMode, onToggleSourceMode, showSourceToggle = true, saveStatus, onImageUpload, aiConfig, onAIToggle }) {
  const { editor } = useEditor();
  const fileInputRef = useRef(null);
  const [, forceToolbarRender] = useState(0);

  useEffect(() => {
    if (!editor) return undefined;

    const refresh = () => forceToolbarRender(value => value + 1);
    editor.on('selectionUpdate', refresh);
    editor.on('transaction', refresh);
    editor.on('update', refresh);
    return () => {
      editor.off('selectionUpdate', refresh);
      editor.off('transaction', refresh);
      editor.off('update', refresh);
    };
  }, [editor]);

  if (!editor) return null;

  const headingActive = [1, 2, 3, 4].some(level => editor.isActive('heading', { level }));
  const listActive = editor.isActive('bulletList') || editor.isActive('orderedList');
  const aiEnabled = Boolean(aiConfig?.enabled);

  async function handleImageFile(file) {
    if (!file || !onImageUpload) return;
    const attrs = await onImageUpload(file);
    editor.chain().focus().insertContent(imageAttrsToHtml(attrs)).run();
  }

  function toggleAI() {
    const config = aiConfig || {};
    const newConfig = { ...config, enabled: !config.enabled };
    if (config.enabled) editor.commands.clearAICompletion?.();
    onAIToggle?.(newConfig);
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
  onAIToggle,
  aiConfig
}) {
  const initialContent = useMemo(() => markdownToHtml(value), []);
  const aiConfigRef = useRef(aiConfig || {});

  useEffect(() => {
    aiConfigRef.current = aiConfig || {};
  }, [aiConfig]);

  const aiExtension = useMemo(() => createAICompletionExtension(() => aiConfigRef.current), []);

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

  function focusEndWhenClickingBlankSpace(view, event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;

    const prose = target.closest('.novel-project-editor-prose');
    if (!prose || target !== prose) return false;
    if (!isClickBelowLastBlock(prose, event)) return false;

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
            aiConfig={aiConfig}
            onAIToggle={onAIToggle}
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
  return isClickBelowLastBlock(prose, event, true);
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
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    parts.push({ node, start: offset });
    offset += node.nodeValue.length;
    node = walker.nextNode();
  }

  const text = parts.map(part => part.node.nodeValue).join('');
  const lowerText = text.toLowerCase();
  const needle = query.toLowerCase();
  let index = -1;
  for (let i = 0; i <= occurrenceIndex; i++) {
    index = lowerText.indexOf(needle, index + 1);
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
    onAIToggle: options.onAIToggle,
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
        onAIToggle={state.onAIToggle}
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
