'use strict';
const vscode = require('vscode');
const { remap, changes, wholeRange, position } = require('../runtime/server/src/reviewManager');
const { relocate, headings } = require('../runtime/server/src/structures');

class ReviewUi {
  constructor(uri, client) {
    this.uri = uri; this.client = client; this.text = '';
    this.reviews = []; this.issues = []; this.generation = 0;
    this.outlineEmitter = new vscode.EventEmitter(); this.issueEmitter = new vscode.EventEmitter();
    this.yellow = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(230, 185, 35, 0.25)', overviewRulerColor: '#d6af22', overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.red = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(220, 55, 55, 0.25)', overviewRulerColor: '#df5555', overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.issueMark = vscode.window.createTextEditorDecorationType({ borderWidth: '0 0 1px 0', borderStyle: 'solid', borderColor: '#568cdd', textDecoration: 'underline' });
    this.outlineProvider = { onDidChangeTreeData: this.outlineEmitter.event, getTreeItem: item => item,
      getChildren: parent => parent ? parent.children : this.outline() };
    this.issueProvider = { onDidChangeTreeData: this.issueEmitter.event, getTreeItem: item => item, getChildren: parent => {
      if (!this.client) return [];
      if (!parent) return ['anchored', 'general'].map(type => {
        const item = new vscode.TreeItem(type === 'anchored' ? '绑定 Issue' : '独立 Issue', vscode.TreeItemCollapsibleState.Expanded); item.group = type; return item;
      });
      return this.issues.filter(issue => issue.type === parent.group && !(issue.conflictId && issue.status === 'resolved')).map(issue => {
        const item = new vscode.TreeItem((issue.status === 'resolved' ? '✓ ' : '') + issue.title);
        item.issue = issue; item.tooltip = issue.description; item.contextValue = issue.conflictId ? 'issueConflict' : 'issue';
        item.command = { command: 'paperReview.showIssue', title: '查看 Issue', arguments: [item] }; return item;
      });
    } };
    // Preserve the original view ID so restored layouts do not show an orphaned Review placeholder.
    // Keep the 0.3.1 ID registered as a hidden alias for layouts created by that candidate.
    this.trees = ['paperReview.reviews', 'paperReview.outline'].map(id => {
      const tree = vscode.window.createTreeView(id, { treeDataProvider: this.outlineProvider });
      tree.title = '章节'; return tree;
    });
    this.trees.push(vscode.window.createTreeView('paperReview.issues', { treeDataProvider: this.issueProvider }));
  }
  document() { return vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === this.uri?.toString()); }
  outline() {
    if (!this.client) return [];
    const roots = [], stack = [], text = this.document()?.getText() ?? this.text;
    for (const heading of headings(text.replace(/\r\n/g, '\n'))) {
      const item = new vscode.TreeItem(heading.title, vscode.TreeItemCollapsibleState.None);
      item.children = []; item.level = heading.level; item.contextValue = 'paperHeading';
      item.command = { command: 'paperReview.locate', title: '定位章节', arguments: [heading] };
      while (stack.length && stack.at(-1).level >= item.level) stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      (parent?.children || roots).push(item); stack.push(item);
    }
    return roots;
  }
  async refresh() {
    if (!this.client) return;
    const generation = ++this.generation, view = await this.client.request('GET', '/v1/human/view');
    if (this.disposed || generation !== this.generation) return;
    this.text = view.text; this.reviews = view.reviews; this.issues = view.issues; this.projection = undefined;
    this.outlineEmitter.fire(); this.issueEmitter.fire(); this.decorate();
  }
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.disposed) { this.outlineEmitter.fire(); this.decorate(); } }, 100);
  }
  projected(text) {
    if (this.projection?.text === text && this.projection.base === this.text) return this.projection;
    let reviews = this.reviews, issues = this.issues;
    if (text !== this.text) {
      const hunks = changes(this.text, text);
      reviews = remap(this.reviews, this.text, text);
      issues = relocate(this.issues, this.text, text, range => wholeRange(range, hunks) ?
        { start: position(range.start, hunks, true), end: position(range.end, hunks, false) } : null);
    }
    return this.projection = { text, base: this.text, reviews, issues };
  }
  decorate() {
    if (!this.uri) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== this.uri.toString()) continue;
      const range = value => new vscode.Range(editor.document.positionAt(value.start), editor.document.positionAt(value.end));
      let reviews = [], issues = [];
      // Preview-only projection: approving still saves and checks server versions.
      try { ({ reviews, issues } = this.projected(editor.document.getText())); } catch { /* A diff budget failure must never paint stale offsets. */ }
      editor.setDecorations(this.yellow, reviews.filter(r => r.status === 'unreviewed').map(r => ({ range: range(r), hoverMessage: r.origin === 'initial' ? '初始正文：待审核' : r.origin === 'manual' ? '手动标记：待审核' : 'AI 修改：待审核' })));
      editor.setDecorations(this.red, reviews.filter(r => r.status === 'needsFix').map(r => ({ range: range(r), hoverMessage: '需修改' })));
      editor.setDecorations(this.issueMark, issues.filter(i => i.type === 'anchored' && i.status === 'open').map(i => ({ range: range(i.anchor), hoverMessage: i.title })));
    }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); for (const item of [...this.trees, this.outlineEmitter, this.issueEmitter, this.yellow, this.red, this.issueMark]) item.dispose(); }
}
module.exports = { ReviewUi };
