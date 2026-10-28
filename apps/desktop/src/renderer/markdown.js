'use strict';

// Minimal Markdown renderer for agent output and REPORT.md. It builds DOM
// nodes with textContent only, so text from the agent or the target can never
// inject markup. Supports headings, paragraphs, lists, fenced code, inline
// code and bold.
(function () {
  function inline(parent, text) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      const token = match[0];
      const node = document.createElement(token.startsWith('`') ? 'code' : 'strong');
      node.textContent = token.startsWith('`') ? token.slice(1, -1) : token.slice(2, -2);
      parent.append(node);
      last = match.index + token.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(container, source) {
    container.replaceChildren();
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      inline(p, paragraph.join(' '));
      container.append(p);
      paragraph = [];
    };
    const closeList = () => {
      list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fence = /^```/.exec(line);
      if (fence) {
        flushParagraph();
        closeList();
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        const pre = document.createElement('pre');
        const node = document.createElement('code');
        node.textContent = code.join('\n');
        pre.append(node);
        container.append(pre);
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        const h = document.createElement(`h${heading[1].length}`);
        inline(h, heading[2]);
        container.append(h);
        continue;
      }
      const item = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
      if (item) {
        flushParagraph();
        const tag = item[1] ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          container.append(list);
        }
        const li = document.createElement('li');
        inline(li, item[2]);
        list.append(li);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      closeList();
      paragraph.push(line.trim());
    }
    flushParagraph();
  }

  window.renderMarkdown = render;
})();
