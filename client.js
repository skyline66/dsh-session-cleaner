/**
 * Session Cleaner — Client half (dsh web Module Loader lane).
 *
 * Registers three additive entries plus one frame-wide confirm dialog:
 *   - `sidebar.workspaces.session.menu.item` — "Delete session…" row action.
 *   - `conversation.session.header.actions` — delete button for the open session.
 *   - `conversation.chat.assistant-actions` — "Delete from here" on finalized
 *     assistant messages (fork prefix + delete original).
 *
 * All Host operations go through same-origin POSTs to `/session-cleaner/api/*`,
 * mirroring the proven community-plugin transport (relative URL resolution
 * against `document.baseURI`, so reverse-proxy prefixes keep working).
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-cleaner',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		let MenuItemButton = undefined
		try {
			MenuItemButton = require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton
		} catch {
			MenuItemButton = undefined
		}

		const NS = 'session-cleaner'
		const DICTS = {
			en: {
				deleteMenu: 'Delete session…',
				deleteSession: 'Delete session',
				confirmDeleteTitle: 'Delete this session?',
				confirmDeleteBody:
					'Permanently delete “{title}” and its entire history? This cannot be undone.',
				confirmDeleteRunning:
					'This session still has running work; confirming stops it and then deletes the session.',
				trimMenu: 'Delete from here…',
				confirmTrimTitle: 'Delete this message and everything after?',
				confirmTrimBody:
					'The earlier conversation is kept in a same-titled continuation session; the original session is then deleted.',
				deleteAction: 'Delete',
				cancelAction: 'Cancel',
				deleting: 'Deleting…',
				operationFailed: 'Operation failed',
			},
			zh: {
				deleteMenu: '删除会话…',
				deleteSession: '删除会话',
				confirmDeleteTitle: '删除此会话？',
				confirmDeleteBody: '将永久删除「{title}」及其全部历史记录，此操作无法撤销。',
				confirmDeleteRunning: '该会话仍有正在运行的任务，确认后将停止这些任务并删除会话。',
				trimMenu: '从此处删除…',
				confirmTrimTitle: '删除此消息及其后的全部内容？',
				confirmTrimBody: '之前的内容会保留到一个同名延续会话中，原会话随后被删除。',
				deleteAction: '删除',
				cancelAction: '取消',
				deleting: '删除中…',
				operationFailed: '操作失败',
			},
		}

		let runtime = undefined

		function interpolate(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params ?? {}, key) ? String(params[key]) : match,
			)
		}

		function getT() {
			let localeId = 'zh'
			try {
				const snapshot = runtime?.ctx?.locale?.getLocale?.()
				localeId = String(snapshot?.id ?? snapshot?.locale ?? 'zh')
			} catch {
				localeId = 'zh'
			}
			const dict = DICTS[localeId] ?? DICTS[localeId.split('-')[0]] ?? DICTS.zh
			return (key, params) => interpolate(dict?.[key] ?? DICTS.en[key] ?? key, params)
		}

		// --- Host transport -----------------------------------------------------

		async function hostCall(method, payload) {
			const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '/'
			const url = new URL(`session-cleaner/api/${method}`, base)
			const response = await fetch(url.href, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload ?? {}),
			})
			const body = await response.json().catch(() => ({}))
			if (!response.ok || body?.ok === false) {
				throw new Error(body?.error?.message || `HTTP ${response.status}`)
			}
			return body
		}

		// --- Confirm dialog external store --------------------------------------

		let pending = null
		const pendingListeners = new Set()
		const subscribePending = listener => {
			pendingListeners.add(listener)
			return () => pendingListeners.delete(listener)
		}
		const getPending = () => pending
		function setPending(next) {
			pending = next
			for (const listener of [...pendingListeners]) {
				try {
					listener()
				} catch {
					// ignore
				}
			}
		}

		function openSessionQuietly(sessionId) {
			try {
				runtime?.uiWorkspace?.openSession?.(sessionId)
			} catch {
				// ignore
			}
		}

		function openBlankQuietly() {
			try {
				runtime?.uiWorkspace?.startSession?.()
			} catch {
				// ignore
			}
		}

		async function runPending() {
			const op = pending
			if (op === null || op.busy) return
			setPending({ ...op, busy: true, error: undefined })
			try {
				if (op.kind === 'trim') {
					const childId = await runtime?.sessions?.fork?.({
						sessionId: op.sessionId,
						atSeq: op.atSeq,
						increaseTitle: false,
					})
					if (typeof childId !== 'string' || childId.length === 0) {
						throw new Error('fork did not return a child session id')
					}
					await hostCall('trim', { sessionId: op.sessionId, childId })
					openSessionQuietly(childId)
				} else {
					await hostCall('delete', { sessionId: op.sessionId })
					if (op.isOpen) openBlankQuietly()
				}
				setPending(null)
			} catch (error) {
				setPending({ ...op, busy: false, error: String(error?.message ?? error) })
			}
		}

		// --- Debug sink: report live slot-prop shapes to the host log -----------

		let debugReportsLeft = 3
		function reportPropsOnce(slot, props, extra) {
			if (debugReportsLeft <= 0) return
			debugReportsLeft -= 1
			const candidates = {}
			for (const key of ['sessionId', 'displayTitle', 'seq', 'messageId', 'turnStartSeq', 'messageSeq']) {
				try {
					const value = props?.[key]
					if (value !== undefined) candidates[key] = typeof value === 'object' ? '[object]' : value
				} catch {
					// ignore
				}
			}
			Promise.resolve(
				hostCall('debug', { data: { slot, keys: Object.keys(props ?? {}), candidates, extra } }),
			).catch(() => {
				// ignore
			})
		}

		// --- Components ----------------------------------------------------------

		const DIALOG_CSS = `
.session-cleaner-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.35); }
.session-cleaner-dialog { width: min(420px, calc(100vw - 48px)); border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 16px 48px rgba(0,0,0,0.25); padding: 18px; font-size: 13px; line-height: 1.5; }
.session-cleaner-dialog h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.session-cleaner-dialog p { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.session-cleaner-dialog .session-cleaner-error { color: var(--dsw-alias-state-error-primary); }
.session-cleaner-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.session-cleaner-actions button { border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); padding: 5px 14px; font-size: 13px; cursor: pointer; }
.session-cleaner-actions button.session-cleaner-primary { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; }
.session-cleaner-actions button:disabled { opacity: 0.6; cursor: default; }
.session-cleaner-header-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0; }
.session-cleaner-header-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.session-cleaner-trim-btn { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.session-cleaner-trim-btn:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.session-cleaner-menu-fallback { display: block; width: 100%; text-align: left; border: none; background: transparent; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; border-radius: 6px; }
.session-cleaner-menu-fallback:hover { background: var(--dsw-alias-bg-layer-2); }
`

		function TrashIcon() {
			return h(
				'svg',
				{ width: 15, height: 15, viewBox: '0 0 64 64', 'aria-hidden': true, fill: 'currentColor' },
				h('rect', { x: 12, y: 18, width: 40, height: 7, rx: 3.5 }),
				h('rect', { x: 25, y: 10, width: 14, height: 6, rx: 3 }),
				h('path', { d: 'M18 28h28l-2.6 25.2A5 5 0 0 1 38.4 58H25.6a5 5 0 0 1-4.98-4.8L18 28z' }),
			)
		}

		function ConfirmOverlay() {
			const state = React.useSyncExternalStore(subscribePending, getPending)
			const t = getT()
			const confirmRef = React.useRef(null)
			React.useEffect(() => {
				if (state !== null) confirmRef.current?.focus?.()
			}, [state?.busy, state !== null])
			React.useEffect(() => {
				if (state === null || state.busy) return undefined
				const onKey = event => {
					if (event.key === 'Escape') setPending(null)
				}
				window.addEventListener('keydown', onKey, true)
				return () => window.removeEventListener('keydown', onKey, true)
			}, [state === null, state?.busy])
			return [
				h('style', { key: 'session-cleaner-css' }, DIALOG_CSS),
				state === null
					? null
					: h(
							'div',
							{ className: 'session-cleaner-overlay', onPointerDown: event => {
									if (event.target === event.currentTarget && !state.busy) setPending(null)
								} },
							h(
								'div',
								{ key: 'dialog', className: 'session-cleaner-dialog', role: 'alertdialog', 'aria-modal': true },
								h('h3', null, t(state.kind === 'trim' ? 'confirmTrimTitle' : 'confirmDeleteTitle')),
								h('p', null, interpolate(t(state.kind === 'trim' ? 'confirmTrimBody' : 'confirmDeleteBody'), { title: state.displayTitle ?? '' })),
								state.kind === 'delete' ? h('p', null, t('confirmDeleteRunning')) : null,
								state.error ? h('p', { className: 'session-cleaner-error' }, `${t('operationFailed')}: ${state.error}`) : null,
								h(
									'div',
									{ className: 'session-cleaner-actions' },
									h('button', { onClick: () => setPending(null), disabled: state.busy }, t('cancelAction')),
									h(
										'button',
										{
											ref: confirmRef,
											className: 'session-cleaner-primary',
											onClick: runPending,
											disabled: state.busy,
										},
										state.busy ? t('deleting') : t('deleteAction'),
									),
								),
							),
						),
			]
		}

		function closeMenuQuietly(props) {
			try {
				if (typeof props?.useMenuOpenState === 'function') {
					const pair = props.useMenuOpenState()
					const setMenuOpen = Array.isArray(pair) ? pair[1] : undefined
					setMenuOpen?.(false)
				}
			} catch {
				// ignore
			}
		}

		function DeleteMenuItem(props) {
			const sessionId = props?.sessionId
			const t = props?.t ?? getT()
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null
			const onSelect = () => {
				closeMenuQuietly(props)
				setPending({ kind: 'delete', sessionId, displayTitle: props.displayTitle ?? '', isOpen: false })
			}
			if (typeof MenuItemButton === 'function') {
				return h(MenuItemButton, { separatorBefore: true, onSelect }, t('deleteMenu'))
			}
			return h(
				'button',
				{ role: 'menuitem', className: 'session-cleaner-menu-fallback', onClick: onSelect },
				t('deleteMenu'),
			)
		}

		function DeleteHeaderAction(props) {
			const sessionId = props?.sessionId ?? props?.session?.sessionId ?? props?.session?.id
			reportPropsOnce('conversation.session.header.actions', props, { sessionId })
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null
			const t = props?.t ?? getT()
			return h('button', {
				className: 'session-cleaner-header-btn',
				title: t('deleteSession'),
				'aria-label': t('deleteSession'),
				onClick: event => {
					event.stopPropagation()
					setPending({
						kind: 'delete',
						sessionId,
						displayTitle: props?.displayTitle ?? props?.title ?? props?.session?.title ?? '',
						isOpen: true,
					})
				},
			}, h(TrashIcon))
		}

		function firstSafeInteger(...values) {
			for (const value of values) {
				if (Number.isSafeInteger(value) && value > 0) return value
			}
			return undefined
		}

		function TrimMessageAction(props) {
			const sessionId = props?.sessionId ?? props?.session?.sessionId
			const node = props?.node ?? props?.message ?? {}
			const seq = firstSafeInteger(
				props?.seq,
				node?.seq,
				node?.messageSeq,
				node?.turnStartSeq,
				props?.messageId && undefined,
				props?.turnStartSeq,
				props?.event?.seq,
			)
			if (debugReportsLeft > 0) {
				reportPropsOnce('conversation.chat.assistant-actions', props, { sessionId, seq, messageId: props?.messageId })
			}
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null
			if (!Number.isSafeInteger(seq) || seq < 1) return null
			const t = props?.t ?? getT()
			return h('button', {
				className: 'session-cleaner-trim-btn',
				title: t('confirmTrimTitle'),
				onClick: event => {
					event.stopPropagation()
					setPending({ kind: 'trim', sessionId, atSeq: seq, displayTitle: props?.displayTitle ?? '', isOpen: true })
				},
			}, h(TrashIcon), t('trimMenu'))
		}

		// --- Plugin body ----------------------------------------------------------

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				try {
					ctx.locale?.register?.(NS, DICTS)
				} catch {
					// Locale service overload unavailable; the built-in fallback dict still renders.
				}
				runtime = { ctx, sessions: ctx.sessions, uiWorkspace: ctx.uiWorkspace }

				const register = (slot, id, order, component, injected) =>
					ctx.slots.register({ name: slot, id, order, locale: NS, inject: injected }, component)

				ctx.effect(
					() =>
						ctx.slots.inject('shell.overlay', () =>
							register('shell.overlay', 'session-cleaner.confirm', 900, ConfirmOverlay),
						),
					'session-cleaner: confirm overlay',
				)
				ctx.effect(
					() =>
						ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
							register(
								'sidebar.workspaces.session.menu.item',
								'session-cleaner.delete',
								500,
								DeleteMenuItem,
								() => ({}),
							),
						),
					'session-cleaner: session menu item',
				)
				ctx.effect(
					() =>
						ctx.slots.inject('conversation.session.header.actions', () =>
							register(
								'conversation.session.header.actions',
								'session-cleaner.delete-current',
								500,
								DeleteHeaderAction,
								() => ({}),
							),
						),
					'session-cleaner: header action',
				)
				ctx.effect(
					() =>
						ctx.slots.inject('conversation.chat.assistant-actions', () =>
							register(
								'conversation.chat.assistant-actions',
								'session-cleaner.trim',
								500,
								TrimMessageAction,
								() => ({}),
							),
						),
					'session-cleaner: trim action',
				)
			},
		}
	},
})
