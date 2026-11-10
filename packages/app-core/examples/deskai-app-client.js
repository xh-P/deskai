/* Embed this helper in a self-contained DeskAI cooperative HTML artifact. */
globalThis.DeskAIApp = {
  connect({ manifest, snapshot, onAction, onStatus = () => {} }) {
    let revision = 0, socket, busy = false, registered = false;
    const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    const client = {
      get connected() { return registered && socket?.readyState === WebSocket.OPEN; },
      get busy() { return busy; },
      publish(eventType, payload = {}) {
        if (!client.connected) return;
        if (busy) throw new Error('A host action is in progress');
        send({ type: 'state', revision: ++revision, state: snapshot() });
        if (eventType) send({ type: 'event', eventType, payload, revision });
      }
    };
    try {
      const fragment = location.hash.slice(1);
      if (!fragment) { onStatus('standalone'); return client; }
      history.replaceState(null, '', location.pathname);
      const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(fragment.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
      socket = new WebSocket(config.websocket);
      socket.onopen = () => send({ type: 'register', ticket: config.ticket, manifest });
      socket.onclose = () => { registered = false; onStatus('disconnected'); };
      socket.onerror = () => onStatus('error');
      socket.onmessage = async event => {
        const message = JSON.parse(event.data);
        if (message.type === 'registered') { registered = true; client.publish(); onStatus('connected'); }
        else if (message.type === 'error') onStatus('error', message.error);
        else if (message.type === 'action') {
          busy = true; let outcome;
          try {
            outcome = message.expectedRevision === revision
              ? await onAction(message.actionType, message.payload)
              : { accepted: false, reason: 'Stale revision' };
          } catch (error) { outcome = { accepted: false, reason: String(error?.message || error) }; }
          const accepted = outcome?.accepted === true;
          if (accepted) revision++;
          send({ type: 'receipt', actionId: message.actionId, accepted, revision,
            state: accepted ? snapshot() : undefined, reason: String(outcome?.reason || '') });
          busy = false;
        }
      };
    } catch (error) { onStatus('error', String(error)); }
    return client;
  }
};
