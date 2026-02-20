// 用于存储“布局视口”的原始高度（键盘未弹出时）
let originalLayoutViewportHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight || 0);

let rafId = 0;

const isTextInputLike = (el) => {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tagName = el.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
};

const isProbablyIOS = () => {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = navigator.maxTouchPoints || 0;
    return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
};

const shouldSuppressMessageHover = () => {
    if (!isProbablyIOS()) return false;
    const active = document.activeElement;
    return !!(active && active instanceof Element && active.id === 'message-input');
};

const setMessageHoverSuppressed = (enabled) => {
    try {
        if (!isProbablyIOS()) return;
        document.body?.classList?.toggle('cerebr-suppress-message-hover', !!enabled);
    } catch {
        // ignore
    }
};

const syncMessageHoverSuppression = () => {
    try {
        document.body?.classList?.toggle('cerebr-suppress-message-hover', shouldSuppressMessageHover());
    } catch {
        // ignore
    }
};

function getLayoutViewportHeight() {
    // iOS Safari 上 window.innerHeight 可能更接近 visual viewport，
    // clientHeight 更接近 layout viewport。取较大值更稳妥。
    return Math.max(window.innerHeight, document.documentElement?.clientHeight || 0);
}

function getKeyboardOverlayPx(layoutHeight) {
    const visual = window.visualViewport;
    if (!visual) return 0;
    const visualBottom = (visual.height || 0) + (visual.offsetTop || 0);
    return Math.max(0, layoutHeight - visualBottom);
}

function scheduleViewportUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        setViewportVars();
    });
}

function setViewportVars() {
    const layoutHeight = getLayoutViewportHeight();

    // 获取实际视口高度（用于一些 100vh 的兼容场景；目前项目内不强依赖）
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    const keyboardOverlayPx = getKeyboardOverlayPx(layoutHeight);
    const layoutKeyboardPx = Math.max(0, originalLayoutViewportHeight - layoutHeight);
    const effectiveKeyboardPx = Math.max(layoutKeyboardPx, keyboardOverlayPx);

    const KEYBOARD_VISIBLE_MIN_PX = 80;
    const isKeyboardVisible = isTextInputLike(document.activeElement) && effectiveKeyboardPx > KEYBOARD_VISIBLE_MIN_PX;
    // 输入框聚焦时同步抑制消息的“粘住 hover”上浮（iOS Safari）
    syncMessageHoverSuppression();

    // iOS Safari quirk: in some rendering states (e.g. a transformed/hover-stuck element),
    // CSS-based keyboard offset compensation may fail to apply. Use inline styles as a
    // last-resort, high-priority path for the input bar to ensure it stays above the keyboard.
    try {
        const inputContainer = document.getElementById('input-container');
        const active = document.activeElement;
        const activeWithinInput = !!(
            inputContainer &&
            active &&
            active instanceof Element &&
            inputContainer.contains(active)
        );
        const shouldInlineLift = activeWithinInput && isKeyboardVisible && keyboardOverlayPx > 0;

        if (inputContainer) {
            if (shouldInlineLift) {
                inputContainer.style.marginBottom = '0px';
                inputContainer.style.transform = `translate3d(0, -${Math.round(keyboardOverlayPx)}px, 0)`;
                inputContainer.style.willChange = 'transform';
            } else {
                inputContainer.style.transform = '';
                inputContainer.style.marginBottom = '';
                inputContainer.style.willChange = '';
            }
        }
    } catch {
        // ignore
    }

    if (isKeyboardVisible) {
        // --keyboard-height 用于聊天列表的底部 padding，保证内容不会被键盘遮挡
        document.documentElement.style.setProperty('--keyboard-height', `${Math.round(effectiveKeyboardPx)}px`);
        // --keyboard-offset 只用于“键盘覆盖但布局不缩小”的情况，驱动输入栏上移
        document.documentElement.style.setProperty('--keyboard-offset', `${Math.round(keyboardOverlayPx)}px`);
        // 保持原有语义：只有在 layout viewport 真的变小时才补偿 top margin
        document.documentElement.style.setProperty('--chat-top-margin', `${Math.round(layoutKeyboardPx)}px`);
        document.body.classList.add('keyboard-visible');
        return;
    }

    document.documentElement.style.setProperty('--keyboard-height', '0px');
    document.documentElement.style.setProperty('--keyboard-offset', '0px');
    document.documentElement.style.setProperty('--chat-top-margin', '0px');
    document.body.classList.remove('keyboard-visible');
    // 键盘收起时也同步清理一次（避免 focus 状态异常导致 class 残留）
    syncMessageHoverSuppression();

    // 更新原始布局视口高度（键盘收起/未弹出时才更新）
    originalLayoutViewportHeight = layoutHeight;
}

const scheduleBurstUpdates = () => {
    // iOS 键盘动画期间，visualViewport 值会在一段时间内变化；
    // 做一小段“脉冲更新”，比仅依赖 resize 更稳。
    for (const delay of [0, 40, 80, 120, 180, 260, 360, 520, 720]) {
        setTimeout(scheduleViewportUpdate, delay);
    }
};

// 初始设置
setViewportVars();

// 监听视口变化（包括输入法弹出/收起）
window.addEventListener('resize', scheduleViewportUpdate);

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleViewportUpdate);
    window.visualViewport.addEventListener('scroll', scheduleViewportUpdate);
}

// 监听输入框焦点事件（main.js 可能在 DOMContentLoaded 之后动态 import）
document.addEventListener(
    'focusin',
    (event) => {
        if (!isTextInputLike(event?.target)) return;
        // 立即抑制消息 hover，上浮状态不应干扰键盘弹起期间的布局/合成。
        if (event?.target instanceof Element && event.target.id === 'message-input') {
            setMessageHoverSuppressed(true);
        }
        scheduleBurstUpdates();
    },
    true
);

document.addEventListener(
    'focusout',
    (event) => {
        if (!isTextInputLike(event?.target)) return;
        if (event?.target instanceof Element && event.target.id === 'message-input') {
            setMessageHoverSuppressed(false);
        }
        scheduleBurstUpdates();
    },
    true
);
