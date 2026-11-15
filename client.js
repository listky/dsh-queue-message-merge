// Generated from client.source.mjs by build.mjs.
window.__ModuleLoader__.load({
  id: "dsh-queue-message-merge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    Object.defineProperty(exports, "__esModule", { value: true });
    const React = require("react");
    const { defineStore } = require("@deepseek-ai/dsh-client-store");
    const { Toast } = require("@deepseek-ai/dsh-client-ui-primitives");
    const LOCALE_NAMESPACE = "queue-message-merge";
    const QUEUE_SLOT_ID = "queue-message-merge";
    const RECOVERY_PERSIST_KEY = "dsh.queue-message-merge.recovery.v1";
    const SEPARATOR = ";";
    const PROJECTION_TIMEOUT_MS = 2500;

    const inject = ["locale"];

    const locales = {
      zh: {
        button: "合并排队",
        tooltip: "合并 {count} 条排队消息。",
        unsupported: "含附件、非文本或空白消息，暂不合并。",
        tooFew: "至少需要两条普通纯文本排队消息。",
        changed: "队列已变化，请重新确认后再合并。",
        unavailable: "当前会话暂不可用。",
        editFailed: "无法编辑首条排队消息，未继续移除其他消息。",
        partial: "合并只完成了一部分。请检查队列，确认后再解锁。",
        uncertain: "服务端结果不明确。已暂停自动重试，请先检查队列。",
        failure: "合并结果不明确。已暂停自动重试，请先检查队列。",
        guardUnavailable: "无法保存恢复状态，未执行合并。",
        success: "已合并 {count} 条消息，仍保持排队状态。",
        recoveryTooltip: "上次合并结果不明确；先检查队列再解锁。",
        recoveryRequired: "上次合并结果不明确。请检查当前排队内容。",
        recoveryAction: "我已检查，解除保护",
        recoveryCleared: "保护已解除；请再次核对队列后手动合并。",
        recoveryAria: "上次合并结果不明确。激活以查看并解除保护。",
        working: "正在合并…"
      },
      en: {
        button: "Merge queued",
        tooltip: "Merge {count} queued messages.",
        unsupported: "Attachments, non-text, or blank messages cannot be merged.",
        tooFew: "At least two ordinary plain-text queued messages are required.",
        changed: "The queue changed. Review it and try again.",
        unavailable: "The current session is unavailable.",
        editFailed: "Could not edit the first queued message; other messages were not removed.",
        partial: "The merge only partially completed. Review the queue before unlocking.",
        uncertain: "The server result is uncertain. Automatic retry is paused; review the queue first.",
        failure: "The merge result is uncertain. Automatic retry is paused; review the queue first.",
        guardUnavailable: "Could not save recovery state; no merge was attempted.",
        success: "Merged {count} messages; the result remains queued.",
        recoveryTooltip: "The previous result is uncertain; review the queue before unlocking.",
        recoveryRequired: "The previous merge result is uncertain. Review the queued messages.",
        recoveryAction: "I checked; unlock",
        recoveryCleared: "Recovery protection cleared. Review the queue again before merging.",
        recoveryAria: "The previous merge result is uncertain. Activate to review and unlock.",
        working: "Merging…"
      }
    };

    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    function readTextQueue(inbox) {
      if (!isRecord(inbox) || !Array.isArray(inbox["next-turn"])) {
        return { ok: false, reason: "unavailable", count: 0, items: [] };
      }

      const messages = inbox["next-turn"];
      const items = [];
      const seenIds = new Set();

      for (const message of messages) {
        if (!isRecord(message) || typeof message.id !== "string" || message.id.length === 0 || seenIds.has(message.id)) {
          return { ok: false, reason: "unsupported", count: messages.length, items: [] };
        }
        seenIds.add(message.id);

        if (!Array.isArray(message.content) || message.content.length === 0) {
          return { ok: false, reason: "unsupported", count: messages.length, items: [] };
        }

        let text = "";
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
            return { ok: false, reason: "unsupported", count: messages.length, items: [] };
          }
          text += block.text;
        }

        if (text.trim().length === 0) {
          return { ok: false, reason: "unsupported", count: messages.length, items: [] };
        }

        items.push({ id: message.id, text });
      }

      return { ok: true, reason: items.length < 2 ? "too-few" : undefined, count: items.length, items };
    }

    /** Build a safe merge plan from the `inbox` projection; only ordinary next-turn text is eligible. */
    function buildMergePlan(inbox) {
      const queue = readTextQueue(inbox);
      if (!queue.ok || queue.items.length < 2) {
        return { ...queue, ok: false, reason: queue.reason ?? "too-few" };
      }

      const combined = queue.items.map((item) => item.text).join(SEPARATOR);
      if (combined.trim().length === 0) {
        return { ok: false, reason: "unsupported", count: queue.count, items: [] };
      }

      return { ...queue, ok: true, combined };
    }

    function sameQueue(left, right) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
        left.every((item, index) => item.id === right[index]?.id && item.text === right[index]?.text);
    }

    function readSessionInbox(session) {
      try {
        return session?.projections?.faceOf("inbox")?.getSnapshot?.();
      } catch {
        return undefined;
      }
    }

    function isAccepted(result) {
      return isRecord(result) && result.ok === true && isRecord(result.value) && result.value.accepted === true;
    }

    function hasRecoveryGuard(guard) {
      return isRecord(guard) && typeof guard.isLocked === "function" &&
        typeof guard.lock === "function" && typeof guard.unlock === "function";
    }

    function waitForQueue(session, expectedItems) {
      let projection;
      try {
        projection = session?.projections?.faceOf("inbox");
      } catch {
        return Promise.resolve(false);
      }
      if (!projection || typeof projection.getSnapshot !== "function" || typeof projection.subscribe !== "function") {
        return Promise.resolve(false);
      }

      const matches = () => {
        const current = readTextQueue(projection.getSnapshot());
        return current.ok && sameQueue(current.items, expectedItems);
      };

      return new Promise((resolve) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer;

        const finish = (matched) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(matched);
        };
        const check = () => {
          try {
            if (matches()) finish(true);
          } catch {
            // Keep waiting for the projection to publish a valid snapshot.
          }
        };

        timer = setTimeout(() => finish(false), PROJECTION_TIMEOUT_MS);
        try {
          const stop = projection.subscribe(check);
          if (typeof stop !== "function") {
            finish(false);
            return;
          }
          unsubscribe = stop;
          if (settled) unsubscribe();
          check();
        } catch {
          finish(false);
        }
      });
    }

    /**
     * Apply a verified plan without sending anything. The first item is edited before
     * any removals. The per-session recovery guard is written before the first RPC
     * and retained whenever an outcome may be ambiguous; it cannot make the Host's
     * independent updateQueue RPCs atomic or eliminate concurrent-edit races.
     */
    async function mergeQueuedMessages(session, requestedPlan, guard) {
      if (!session || !requestedPlan?.ok || !Array.isArray(requestedPlan.items) || requestedPlan.items.length < 2) {
        return { status: "ineligible" };
      }
      if (!hasRecoveryGuard(guard)) return { status: "guard-unavailable" };

      try {
        if (guard.isLocked()) return { status: "recovery-required" };
      } catch {
        return { status: "guard-unavailable" };
      }

      const currentPlan = buildMergePlan(readSessionInbox(session));
      if (!currentPlan.ok || currentPlan.combined !== requestedPlan.combined || !sameQueue(currentPlan.items, requestedPlan.items)) {
        return { status: "changed" };
      }

      try {
        // Write ahead of mutation so a reload cannot blindly retry an uncertain request.
        guard.lock();
      } catch {
        return { status: "guard-unavailable" };
      }

      const first = currentPlan.items[0];
      let edited = false;
      try {
        const editResult = await session.updateQueue(first.id, {
          kind: "edit",
          content: [{ type: "text", text: currentPlan.combined }]
        });
        if (isRecord(editResult) && editResult.ok === false) {
          guard.unlock();
          return { status: "edit-failed" };
        }
        if (!isAccepted(editResult)) return { status: "uncertain" };
        edited = true;

        let expectedItems = [
          { id: first.id, text: currentPlan.combined },
          ...currentPlan.items.slice(1)
        ];
        if (!(await waitForQueue(session, expectedItems))) return { status: "partial" };

        for (const item of currentPlan.items.slice(1)) {
          const beforeRemove = readTextQueue(readSessionInbox(session));
          if (!beforeRemove.ok || !sameQueue(beforeRemove.items, expectedItems)) {
            return { status: "partial" };
          }

          const removeResult = await session.updateQueue(item.id, { kind: "remove" });
          if (!isAccepted(removeResult)) return { status: "partial" };
          expectedItems = expectedItems.filter((queued) => queued.id !== item.id);
          if (!(await waitForQueue(session, expectedItems))) return { status: "partial" };
        }

        guard.unlock();
        return { status: "success" };
      } catch {
        return { status: edited ? "partial" : "uncertain" };
      }
    }

    function createRecoveryStore() {
      return defineStore({
        init: () => ({ recoveryRequired: false }),
        persist: RECOVERY_PERSIST_KEY,
        actions: {
          requireRecovery(draft) {
            draft.recoveryRequired = true;
          },
          clearRecovery(draft) {
            draft.recoveryRequired = false;
          }
        }
      });
    }

    const activeSessions = new Set();

    function MergeQueueControl({ useProjection, useStore, actions, sessionId, getSession, t }) {
      const inbox = useProjection("inbox");
      const plan = buildMergePlan(inbox);
      const storeState = typeof useStore === "function" ? useStore((state) => state) : undefined;
      const recoveryRequired = storeState?.recoveryRequired === true;
      const storeReady = typeof storeState?.recoveryRequired === "boolean" &&
        typeof actions?.requireRecovery === "function" && typeof actions?.clearRecovery === "function";
      const [busy, setBusy] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const translate = typeof t === "function" ? t : (key) => locales.zh[key] ?? key;

      const showToast = (text, tone, toastActions) => {
        setToast((previous) => ({
          id: (previous?.id ?? 0) + 1,
          text,
          tone,
          actions: toastActions
        }));
      };

      const showRecoveryToast = (text) => {
        showToast(text, undefined, [{
          label: translate("recoveryAction"),
          onClick: () => {
            try {
              actions.clearRecovery();
              showToast(translate("recoveryCleared"), "success");
            } catch {
              showToast(translate("guardUnavailable"));
            }
          }
        }]);
      };

      const count = plan.count ?? 0;
      const tooltipKey = recoveryRequired ? "recoveryTooltip" :
        !storeReady ? "guardUnavailable" :
        plan.ok ? "tooltip" : plan.reason === "too-few" ? "tooFew" :
          plan.reason === "unavailable" ? "unavailable" : "unsupported";
      const tooltip = translate(tooltipKey).replace("{count}", String(count));
      const label = recoveryRequired ? translate("recoveryAria") : `${translate("button")} ${count}`;
      const disabled = busy || !storeReady || (!plan.ok && !recoveryRequired);

      const onMerge = async () => {
        if (busy || !storeReady || typeof sessionId !== "string" || sessionId.length === 0) {
          if (!storeReady) showToast(translate("guardUnavailable"));
          return;
        }
        if (activeSessions.has(sessionId)) return;
        if (recoveryRequired) {
          showRecoveryToast(translate("recoveryRequired"));
          return;
        }
        if (!plan.ok) return;

        activeSessions.add(sessionId);
        setBusy(true);
        try {
          const session = getSession?.();
          if (!session || session.sessionId !== sessionId) {
            showToast(translate("unavailable"));
            return;
          }

          const guard = {
            isLocked: () => recoveryRequired,
            lock: () => actions.requireRecovery(),
            unlock: () => actions.clearRecovery()
          };
          const result = await mergeQueuedMessages(session, plan, guard);
          const keyByStatus = {
            success: "success",
            changed: "changed",
            ineligible: "unsupported",
            "edit-failed": "editFailed",
            partial: "partial",
            uncertain: "uncertain",
            failure: "failure",
            "guard-unavailable": "guardUnavailable",
            "recovery-required": "recoveryRequired"
          };
          const message = translate(keyByStatus[result.status] ?? "failure").replace("{count}", String(count));
          if (result.status === "partial" || result.status === "uncertain" || result.status === "failure" || result.status === "recovery-required") {
            showRecoveryToast(message);
          } else {
            showToast(message, result.status === "success" ? "success" : undefined);
          }
        } catch {
          // The request may have been applied even if its reply was lost; keep the
          // write-ahead guard locked and require an explicit queue review.
          try {
            actions.requireRecovery();
          } catch {
            // The local store may be unavailable; the visible toast still warns.
          }
          showRecoveryToast(translate("failure"));
        } finally {
          activeSessions.delete(sessionId);
          setBusy(false);
        }
      };

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            disabled,
            onClick: onMerge,
            title: tooltip,
            "aria-label": label,
            "aria-busy": busy,
            style: {
              boxSizing: "border-box",
              display: "inline-grid",
              placeItems: "center",
              width: "30px",
              minWidth: "30px",
              height: "30px",
              minHeight: "30px",
              padding: 0,
              flex: "0 0 auto",
              border: "1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .35))",
              borderRadius: "6px",
              background: "transparent",
              color: "var(--dsw-alias-label-primary, inherit)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1
            }
          },
          React.createElement(
            "svg",
            { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", "aria-hidden": true, focusable: "false" },
            React.createElement("path", {
              d: "M2 4h3l5 4h4M2 12h3l5-4m2-2 2 2-2 2",
              stroke: "currentColor",
              strokeWidth: 1.5,
              strokeLinecap: "round",
              strokeLinejoin: "round"
            })
          )
        ),
        toast ? React.createElement(Toast, {
          key: toast.id,
          text: toast.text,
          tone: toast.tone,
          actions: toast.actions,
          holdMs: toast.actions ? 9000 : 5000,
          onDone: () => setToast((current) => current?.id === toast.id ? null : current)
        }) : null
      );
    }

    function apply(ctx) {
      const recoveryStore = createRecoveryStore();
      ctx.effect(
        () => ctx.locale.register(LOCALE_NAMESPACE, locales),
        "queue-message-merge: locale dictionaries"
      );

      ctx.inject(["slots", "sessions"], (scope) => {
        scope.slots.inject("conversation.input.right", () =>
          scope.slots.register(
            {
              name: "conversation.input.right",
              id: QUEUE_SLOT_ID,
              order: 20,
              locale: LOCALE_NAMESPACE,
              store: recoveryStore,
              inject: (sessionId) => ({
                getSession: () => scope.sessions.binding(sessionId)?.session
              })
            },
            MergeQueueControl
          )
        );
      });
    }

    Object.assign(exports, { inject, buildMergePlan, mergeQueuedMessages, apply });
    return module.exports;
  }
});
