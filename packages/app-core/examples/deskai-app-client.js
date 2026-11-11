/* Small AUIP v0 client for single-window DeskAI apps. */
globalThis.DeskAIApp = {
  connect({ snapshot, onAction, onStatus = () => {} }) {
    let socket, auth, revision = 0, busy = false;
    let publishing = Promise.resolve();
    const requests = new Map();
    const call = (method, params) => {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('AUIP request timed out')); }, 10000);
        requests.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'req', id, method, params: { ...auth, ...params } }));
      });
    };
    const publishState = async state => {
      const result = await call('auip.state.publish', { revision: revision + 1, state });
      revision = result.revision;
    };
    const client = {
      get connected() { return !!auth && socket?.readyState === WebSocket.OPEN; },
      get busy() { return busy; },
      publish(type, payload = {}) {
        if (!client.connected) return Promise.resolve();
        const state = structuredClone(snapshot());
        publishing = publishing.then(async () => {
          await publishState(state);
          if (type) await call('auip.event.publish', { event_id: crypto.randomUUID(), event_type: type, actor: 'user', revision, payload });
        }).catch(error => { onStatus('error', error.message); socket.close(); });
        return publishing;
      }
    };
    const handleAction = async action => {
      busy = true;
      try {
        await publishing;
        let result = { accepted: false, reason: 'stale_action_revision' };
        if (action.expected_revision === revision) {
          try { result = await onAction(action.type, action.payload); }
          catch (error) { result = { accepted: false, reason: String(error) }; }
        }
        const accepted = result?.accepted === true;
        const response = await call('auip.action.result', { action_id: action.action_id, accepted,
          resulting_revision: revision + (accepted ? 1 : 0), state: accepted ? snapshot() : undefined, reason: result?.reason });
        revision = response.revision;
      } catch (error) { onStatus('error', error.message); socket.close(); }
      finally { busy = false; }
    };
    async function attach() {
      const fragment = location.hash;
      if (!fragment.startsWith('#amadeus-auip=')) { onStatus('standalone'); return; }
      const encoded = fragment.slice('#amadeus-auip='.length).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const launch = JSON.parse(new TextDecoder().decode(bytes));
      history.replaceState(null, '', location.pathname);
      if (launch.schema !== 'amadeus.auip/launch-v0' || launch.expiresAt * 1000 <= Date.now()) throw new Error('Invalid AUIP launch');
      const response = await fetch('./auip.manifest.json');
      if (!response.ok) throw new Error('AUIP manifest is unavailable');
      const manifest = await response.json();
      socket = new WebSocket(launch.webSocketUrl);
      socket.onclose = () => {
        auth = undefined;
        for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('AUIP disconnected')); }
        requests.clear(); onStatus('disconnected');
      };
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'res') {
          const pending = requests.get(message.id);
          if (!pending) return;
          requests.delete(message.id); clearTimeout(pending.timer);
          if (message.params.ok === false) pending.reject(new Error(message.params.error));
          else pending.resolve(message.params);
        } else if (message.type === 'evt' && message.method === 'auip.action.requested' && message.params.app_session_id === auth?.app_session_id)
          void handleAction(message.params.action);
      };
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('AUIP connection failed')), { once: true });
      });
      const registered = await call('auip.register', { manifest, attach_ticket: launch.attachTicket });
      auth = { app_session_id: registered.app_session_id, bridge_token: registered.bridge_token };
      await publishState(snapshot()); onStatus('connected');
    }
    void attach().catch(error => { onStatus('error', error.message); socket?.close(); });
    return client;
  }
};
