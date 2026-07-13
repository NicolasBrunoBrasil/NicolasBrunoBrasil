// Pilha de desfazer/refazer baseada em comandos.
// Cada comando: { label, undo(), redo() } — a ação já foi aplicada quando entra na pilha.
export class History {
  constructor(app) {
    this.app = app;
    this.undoStack = [];
    this.redoStack = [];
    this.limit = 120;
  }

  push(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emit();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    try { cmd.undo(); } catch (err) { console.error('undo falhou', err); }
    this.redoStack.push(cmd);
    this._emit();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    try { cmd.redo(); } catch (err) { console.error('redo falhou', err); }
    this.undoStack.push(cmd);
    this._emit();
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._emit();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _emit() { this.app.emit('history-changed'); }
}
