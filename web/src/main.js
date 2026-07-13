import { Viewport } from './viewport.js';
import { History } from './history.js';
import { Objects } from './objects.js';
import { Sketch } from './sketch.js';
import { Interact } from './interact.js';
import { Paint } from './paint.js';
import { Sculpt } from './sculpt.js';
import { Ops } from './ops.js';
import { Ruler } from './ruler.js';
import { Measure } from './measure.js';
import { CodeGen } from './codegen.js';
import * as IO from './io.js';
import { UI } from './ui.js';

const app = {
  _listeners: new Map(),
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, []);
    this._listeners.get(evt).push(fn);
  },
  emit(evt) {
    const fns = this._listeners.get(evt);
    if (fns) for (const fn of fns) { try { fn(); } catch (e) { console.error(e); } }
  },
};

app.viewport = new Viewport(document.getElementById('viewport'));
app.viewport.app = app; // para o viewport alcançar interact.tc ao trocar câmera
app.history = new History(app);
app.objects = new Objects(app);
app.sketch = new Sketch(app);
app.paint = new Paint(app);
app.sculpt = new Sculpt(app);
app.interact = new Interact(app);
app.ops = new Ops(app);
app.ruler = new Ruler(app);
app.measure = new Measure(app);
app.codegen = new CodeGen(app);
IO.init(app);
app.io = IO;
app.ui = new UI(app);

app.viewport.start();
IO.tryOfferRestore();

// PWA apenas quando servido por http(s) — no APK os arquivos são locais
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) &&
    location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.App = app; // depuração e testes
