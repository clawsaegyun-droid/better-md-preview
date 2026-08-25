const path = require('path');
const vscode = require('vscode');
const MarkdownIt = require('markdown-it');
const taskLists = require('markdown-it-task-lists');
const footnote = require('markdown-it-footnote');
const hljs = require('highlight.js');

const previews = new Map();
const documentScrollStates = new Map();

function activate(context) {
  const renderer = createMarkdownRenderer();
  const markdownWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');

  context.subscriptions.push(
    vscode.commands.registerCommand('betterMdPreview.openPreview', () => openPreview(context, renderer, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('betterMdPreview.openPreviewToSide', () => openPreview(context, renderer, vscode.ViewColumn.Beside)),
    markdownWatcher,
    vscode.workspace.onDidChangeTextDocument((event) => {
      const key = event.document.uri.toString();
      const preview = previews.get(key);
      if (preview) {
        preview.update(event.document);
      }
    }),
    markdownWatcher.onDidChange((uri) => updatePreviewFromUri(uri)),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        const oldKey = file.oldUri.toString();
        const preview = previews.get(oldKey);
        if (!preview) {
          continue;
        }
        const oldState = documentScrollStates.get(oldKey);
        previews.delete(oldKey);
        preview.setDocumentUri(file.newUri);
        previews.set(file.newUri.toString(), preview);
        if (oldState) {
          documentScrollStates.set(file.newUri.toString(), oldState);
          documentScrollStates.delete(oldKey);
        }
        updatePreviewFromUri(file.newUri);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor.document.languageId !== 'markdown') {
        return;
      }
      const config = vscode.workspace.getConfiguration('betterMdPreview');
      if (!config.get('followEditorSelection')) {
        return;
      }
      const preview = previews.get(event.textEditor.document.uri.toString());
      if (preview) {
        preview.revealEditorLine(event.selections[0].active.line);
      }
    })
  );
}

function deactivate() {}

function openPreview(context, renderer, column) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showInformationMessage('Open a Markdown document first.');
    return;
  }

  const key = editor.document.uri.toString();
  const existing = previews.get(key);
  if (existing) {
    existing.panel.reveal(column);
    existing.update(editor.document);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'betterMdPreview',
    `Preview: ${path.basename(editor.document.fileName)}`,
    column,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'node_modules'),
        vscode.Uri.joinPath(context.extensionUri, 'media')
      ]
    }
  );

  const preview = new MarkdownPreview(context, panel, renderer, editor.document);
  previews.set(key, preview);
  panel.onDidDispose(() => {
    previews.delete(preview.documentKey);
  });
  panel.webview.onDidReceiveMessage((message) => {
    if (!message || message.type !== 'state') {
      return;
    }
    preview.rememberScrollState(message);
  });
  preview.update(editor.document);
}

function updatePreviewFromUri(uri) {
  const preview = previews.get(uri.toString());
  if (!preview) {
    return;
  }
  vscode.workspace.openTextDocument(uri).then((document) => {
    if (document.languageId === 'markdown') {
      preview.update(document);
    }
  }, () => {
    previews.delete(uri.toString());
  });
}

class MarkdownPreview {
  constructor(context, panel, renderer, document) {
    this.context = context;
    this.panel = panel;
    this.renderer = renderer;
    this.documentUri = document.uri;
    this.lastOutline = [];
  }

  get documentKey() {
    return this.documentUri.toString();
  }

  setDocumentUri(uri) {
    this.documentUri = uri;
  }

  rememberScrollState(message) {
    const scrollY = Number(message.scrollY);
    if (!Number.isFinite(scrollY) || scrollY < 0) {
      return;
    }
    documentScrollStates.set(this.documentKey, {
      scrollY,
      activeId: typeof message.activeId === 'string' ? message.activeId : '',
      collapsedIds: Array.isArray(message.collapsedIds)
        ? message.collapsedIds.filter((id) => typeof id === 'string')
        : []
    });
  }

  update(document) {
    this.documentUri = document.uri;
    const { html, outline } = this.renderer.render(document.getText());
    this.lastOutline = outline;
    this.panel.title = `Preview: ${path.basename(document.fileName)}`;
    this.panel.webview.html = getWebviewHtml(
      this.context,
      this.panel.webview,
      document,
      html,
      outline,
      documentScrollStates.get(this.documentKey)
    );
  }

  revealEditorLine(line) {
    if (!this.lastOutline.length) {
      return;
    }
    let target = this.lastOutline[0];
    for (const item of this.lastOutline) {
      if (item.line <= line) {
        target = item;
      } else {
        break;
      }
    }
    this.panel.webview.postMessage({ type: 'reveal', id: target.id });
  }
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre><code class="hljs language-${escapeHtml(lang)}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
        } catch {
          return '';
        }
      }
      return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
    }
  })
    .use(taskLists, { enabled: true, label: true, labelAfter: true })
    .use(footnote);

  md.core.ruler.push('better_heading_ids', (state) => {
    const slugCounts = new Map();
    const outline = [];

    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== 'heading_open') {
        continue;
      }

      const inline = state.tokens[index + 1];
      const text = inline && inline.type === 'inline' ? inline.content : '';
      const level = Number(token.tag.slice(1));
      const id = uniqueSlug(text, slugCounts);
      token.attrSet('id', id);
      outline.push({
        id,
        text: text || token.tag.toUpperCase(),
        level,
        line: token.map ? token.map[0] : 0
      });
    }

    state.env.outline = outline;
  });

  return {
    render(text) {
      const env = {};
      return {
        html: md.render(text, env),
        outline: env.outline || []
      };
    }
  };
}

function getWebviewHtml(context, webview, document, body, outline, scrollState) {
  const githubCss = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'github-markdown-css', 'github-markdown.css'));
  const highlightCss = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'highlight.js', 'styles', 'github.css'));
  const appCss = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css'));
  const nonce = getNonce();
  const initialScrollState = JSON.stringify(normalizeScrollState(scrollState));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${githubCss}">
  <link rel="stylesheet" href="${highlightCss}">
  <link rel="stylesheet" href="${appCss}">
  <title>${escapeHtml(path.basename(document.fileName))}</title>
</head>
<body>
  <form class="find" id="find" hidden role="search" aria-label="Find in preview">
    <input class="find__input" id="findInput" type="search" autocomplete="off" spellcheck="false" aria-label="Find in preview">
    <span class="find__status" id="findStatus" aria-live="polite"></span>
    <button class="find__button" id="findPrevious" type="button" title="Previous match" aria-label="Previous match">&#8593;</button>
    <button class="find__button" id="findNext" type="button" title="Next match" aria-label="Next match">&#8595;</button>
  </form>
  <aside class="legend" aria-label="Heading legend">
    <div class="legend__title">Title Map</div>
    <nav class="legend__nav">
      ${renderLegend(outline)}
    </nav>
  </aside>
  <main class="markdown-body">
    ${body || '<p></p>'}
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const savedScrollState = vscode.getState();
    const initialScrollState = normalizeClientScrollState(savedScrollState || ${initialScrollState});
    const activeClass = 'legend__link--active';
    const find = document.getElementById('find');
    const findInput = document.getElementById('findInput');
    const findStatus = document.getElementById('findStatus');
    const findPrevious = document.getElementById('findPrevious');
    const findNext = document.getElementById('findNext');
    const searchRoot = document.querySelector('.markdown-body');
    let findQuery = '';
    let findMarks = [];
    let findIndex = -1;
    let activeHeadingId = initialScrollState.activeId || '';
    const collapsedIds = new Set(initialScrollState.collapsedIds || []);
    const sections = new Map();
    const foldEntries = [];
    let stateTimer = 0;

    function reveal(id) {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(id);
    }

    function setActive(id) {
      activeHeadingId = id || '';
      document.querySelectorAll('.legend__link').forEach((link) => {
        link.classList.toggle(activeClass, link.dataset.target === id);
      });
      postScrollStateSoon();
    }

    function postScrollStateSoon() {
      if (stateTimer) {
        return;
      }
      stateTimer = window.setTimeout(() => {
        stateTimer = 0;
        const state = {
          type: 'state',
          scrollY: window.scrollY,
          activeId: activeHeadingId,
          collapsedIds: [...collapsedIds]
        };
        vscode.setState(state);
        vscode.postMessage(state);
      }, 120);
    }

    function normalizeClientScrollState(state) {
      if (!state || typeof state !== 'object') {
        return { scrollY: 0, activeId: '' };
      }
      const scrollY = Number(state.scrollY);
      return {
        scrollY: Number.isFinite(scrollY) && scrollY > 0 ? scrollY : 0,
        activeId: typeof state.activeId === 'string' ? state.activeId : '',
        collapsedIds: Array.isArray(state.collapsedIds)
          ? state.collapsedIds.filter((id) => typeof id === 'string')
          : []
      };
    }

    document.querySelectorAll('.legend__link').forEach((link) => {
      link.addEventListener('click', () => reveal(link.dataset.target));
    });

    document.querySelectorAll('[data-fold-toggle]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFold(button.dataset.foldToggle);
      });
    });

    function preparePreviewFolding() {
      const stack = [];
      [...searchRoot.children].forEach((element) => {
        const headingLevel = getHeadingLevel(element);
        if (headingLevel) {
          while (stack.length && stack[stack.length - 1].level >= headingLevel) {
            stack.pop();
          }
          const section = {
            id: element.id,
            level: headingLevel,
            heading: element,
            childIds: [],
            ancestorIds: stack.map((item) => item.id)
          };
          if (stack.length) {
            stack[stack.length - 1].childIds.push(section.id);
          }
          sections.set(section.id, section);
          foldEntries.push({ element, ids: section.ancestorIds, isHeading: true, sectionId: section.id });
          stack.push(section);
          decorateHeading(element, section.id);
          return;
        }
        foldEntries.push({ element, ids: stack.map((item) => item.id), isHeading: false, sectionId: '' });
      });
      applyFoldState();
    }

    function getHeadingLevel(element) {
      const match = /^H([1-6])$/.exec(element.tagName);
      return match ? Number(match[1]) : 0;
    }

    function decorateHeading(heading, id) {
      heading.classList.add('preview-heading');
      const button = document.createElement('button');
      button.className = 'preview-fold';
      button.type = 'button';
      button.dataset.foldToggle = id;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFold(id);
      });
      heading.insertBefore(button, heading.firstChild);
    }

    function toggleFold(id) {
      if (!id || !sections.has(id)) {
        return;
      }
      if (collapsedIds.has(id)) {
        collapsedIds.delete(id);
      } else {
        collapsedIds.add(id);
      }
      applyFoldState();
      postScrollStateSoon();
    }

    function applyFoldState() {
      foldEntries.forEach((entry) => {
        const hiddenByAncestor = entry.ids.some((id) => collapsedIds.has(id));
        const hidden = entry.isHeading ? hiddenByAncestor : hiddenByAncestor || entry.ids.some((id) => id === entry.sectionId && collapsedIds.has(id));
        entry.element.hidden = hidden;
      });
      document.querySelectorAll('[data-heading-id]').forEach((node) => {
        const id = node.dataset.headingId;
        const collapsed = collapsedIds.has(id);
        const section = sections.get(id);
        const hidden = section ? section.ancestorIds.some((ancestorId) => collapsedIds.has(ancestorId)) : false;
        node.hidden = hidden;
        node.classList.toggle('is-collapsed', collapsed);
      });
      document.querySelectorAll('[data-fold-toggle]').forEach((button) => {
        const id = button.dataset.foldToggle;
        const collapsed = collapsedIds.has(id);
        button.classList.toggle('is-collapsed', collapsed);
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
        button.title = collapsed ? 'Expand section' : 'Collapse section';
      });
    }

    function openFind() {
      find.hidden = false;
      findInput.focus();
      findInput.select();
      if (findInput.value) {
        updateFind(findInput.value, findIndex < 0 ? 0 : findIndex);
      }
    }

    function closeFind() {
      find.hidden = true;
      findInput.blur();
      clearFindMarks();
      findStatus.textContent = '';
      findQuery = '';
      findMarks = [];
      findIndex = -1;
    }

    function clearFindMarks() {
      document.querySelectorAll('mark.find__mark').forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) {
          return;
        }
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
    }

    function collectTextNodes(root) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.parentElement && node.parentElement.closest('script, style, mark.find__mark')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.parentElement && node.parentElement.closest('[hidden]')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node = walker.nextNode();
      while (node) {
        nodes.push(node);
        node = walker.nextNode();
      }
      return nodes;
    }

    function updateFind(query, preferredIndex) {
      findQuery = query;
      clearFindMarks();
      findMarks = [];
      findIndex = -1;

      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (!normalizedQuery) {
        findStatus.textContent = '';
        return;
      }

      collectTextNodes(searchRoot).forEach((node) => {
        const text = node.nodeValue;
        const lowerText = text.toLocaleLowerCase();
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let matchAt = lowerText.indexOf(normalizedQuery);

        while (matchAt !== -1) {
          if (matchAt > cursor) {
            fragment.appendChild(document.createTextNode(text.slice(cursor, matchAt)));
          }
          const mark = document.createElement('mark');
          mark.className = 'find__mark';
          mark.textContent = text.slice(matchAt, matchAt + normalizedQuery.length);
          fragment.appendChild(mark);
          findMarks.push(mark);
          cursor = matchAt + normalizedQuery.length;
          matchAt = lowerText.indexOf(normalizedQuery, cursor);
        }

        if (cursor === 0) {
          return;
        }
        if (cursor < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(cursor)));
        }
        node.parentNode.replaceChild(fragment, node);
      });

      if (!findMarks.length) {
        findStatus.textContent = 'No results';
        return;
      }

      activateFindMatch(Math.min(Math.max(preferredIndex, 0), findMarks.length - 1));
    }

    function activateFindMatch(index) {
      if (!findMarks.length) {
        findStatus.textContent = findQuery ? 'No results' : '';
        return;
      }
      if (findIndex >= 0 && findMarks[findIndex]) {
        findMarks[findIndex].classList.remove('find__mark--active');
      }
      findIndex = (index + findMarks.length) % findMarks.length;
      const active = findMarks[findIndex];
      active.classList.add('find__mark--active');
      active.scrollIntoView({ behavior: 'smooth', block: 'center' });
      findStatus.textContent = String(findIndex + 1) + ' of ' + String(findMarks.length);
    }

    find.addEventListener('submit', (event) => {
      event.preventDefault();
      activateFindMatch(findIndex + (event.shiftKey ? -1 : 1));
    });

    findInput.addEventListener('input', () => updateFind(findInput.value, 0));
    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        activateFindMatch(findIndex + (event.shiftKey ? -1 : 1));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFind();
      }
    });
    findPrevious.addEventListener('click', () => activateFindMatch(findIndex - 1));
    findNext.addEventListener('click', () => activateFindMatch(findIndex + 1));

    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        openFind();
      } else if (event.key === 'Escape' && !find.hidden) {
        event.preventDefault();
        closeFind();
      }
    });

    window.addEventListener('scroll', postScrollStateSoon, { passive: true });

    const headings = [...document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6')];
    preparePreviewFolding();
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) {
        setActive(visible[0].target.id);
      }
    }, { rootMargin: '-12% 0px -72% 0px', threshold: 0 });
    headings.forEach((heading) => observer.observe(heading));

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'reveal') {
        reveal(event.data.id);
      }
    });

    requestAnimationFrame(() => {
      if (initialScrollState.activeId && document.getElementById(initialScrollState.activeId)) {
        setActive(initialScrollState.activeId);
      }
      window.scrollTo({ top: initialScrollState.scrollY || 0, behavior: 'auto' });
      postScrollStateSoon();
    });
  </script>
</body>
</html>`;
}

function normalizeScrollState(scrollState) {
  if (!scrollState) {
    return { scrollY: 0, activeId: '' };
  }
  const scrollY = Number(scrollState.scrollY);
  return {
    scrollY: Number.isFinite(scrollY) && scrollY > 0 ? scrollY : 0,
    activeId: typeof scrollState.activeId === 'string' ? scrollState.activeId : '',
    collapsedIds: Array.isArray(scrollState.collapsedIds)
      ? scrollState.collapsedIds.filter((id) => typeof id === 'string')
      : []
  };
}

function renderLegend(outline) {
  if (!outline.length) {
    return '<div class="legend__empty">No headings</div>';
  }

  return renderLegendNodes(buildOutlineTree(outline));
}

function renderLegendNodes(nodes) {
  return nodes.map((item) => {
    const level = Math.min(Math.max(item.level, 1), 6);
    const children = item.children.length ? `<div class="legend__children">${renderLegendNodes(item.children)}</div>` : '';
    const toggle = `<button class="legend__toggle" data-fold-toggle="${escapeAttribute(item.id)}" type="button"></button>`;
    return `<div class="legend__item legend__item--h${level}" data-heading-id="${escapeAttribute(item.id)}">
      <div class="legend__row">
        ${toggle}
        <button class="legend__link" data-target="${escapeAttribute(item.id)}" type="button">
          <span class="legend__level">H${level}</span>
          <span class="legend__text">${escapeHtml(item.text)}</span>
        </button>
      </div>
      ${children}
    </div>`;
  }).join('');
}

function buildOutlineTree(outline) {
  const roots = [];
  const stack = [];

  for (const item of outline) {
    const node = { ...item, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  return roots;
}

function uniqueSlug(text, counts) {
  const base = slugify(text) || 'heading';
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function getNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

module.exports = {
  activate,
  deactivate
};
