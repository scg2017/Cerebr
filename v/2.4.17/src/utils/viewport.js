// 用于存储“布局视口”的原始高度（键盘未弹出时）
let originalLayoutViewportHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight || 0);

let rafId = 0;

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
    const isKeyboardVisible = effectiveKeyboardPx > KEYBOARD_VISIBLE_MIN_PX;

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

    // 更新原始布局视口高度（键盘收起/未弹出时才更新）
    originalLayoutViewportHeight = layoutHeight;
}

const isTextInputLike = (el) => {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tagName = el.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
};

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
        scheduleBurstUpdates();
    },
    true
);

document.addEventListener(
    'focusout',
    (event) => {
        if (!isTextInputLike(event?.target)) return;
        scheduleBurstUpdates();
    },
    true
);
