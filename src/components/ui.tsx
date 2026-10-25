'use client';

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Info,
  LoaderCircle,
  NotebookPen,
  TriangleAlert,
  X,
} from 'lucide-react';
import * as SelectPrimitive from '@radix-ui/react-select';

type SelectProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'children'
> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  required?: boolean;
  placeholder?: string;
};
const EMPTY_OPTION = '__chatpony_empty_option__';
function optionLabel(nodes: ReactNode): string {
  return Children.toArray(nodes)
    .map((node) =>
      typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : isValidElement<{ children?: ReactNode }>(node)
          ? optionLabel(node.props.children)
          : '',
    )
    .join('');
}
function selectOptions(nodes: ReactNode): { value: string; label: string; disabled: boolean }[] {
  const options: { value: string; label: string; disabled: boolean }[] = [];
  Children.forEach(nodes, (node) => {
    if (
      !isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(node)
    )
      return;
    if (node.type === 'option') {
      const label = optionLabel(node.props.children);
      options.push({
        value: node.props.value === undefined ? label : String(node.props.value),
        label,
        disabled: !!node.props.disabled,
      });
    } else if (node.props.children) options.push(...selectOptions(node.props.children));
  });
  return options;
}

/** Accessible styled selection, with the menu kept inside native dialogs' top layer. */
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  name,
  required,
  disabled,
  placeholder,
  className = '',
  ...triggerProps
}: SelectProps) {
  const options = selectOptions(children);
  const [internal, setInternal] = useState(() => String(defaultValue ?? options[0]?.value ?? ''));
  const selected = value === undefined ? internal : String(value);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const empty = options.find((option) => option.value === '');
  const radixValue = selected === '' ? (empty && !required ? EMPTY_OPTION : '') : selected;
  const text = options.find((option) => option.value === selected)?.label;
  return (
    <>
      {name && <input type="hidden" name={name} value={selected} disabled={disabled} />}
      <SelectPrimitive.Root
        value={radixValue}
        disabled={disabled}
        required={required}
        open={open}
        onOpenChange={(next) => {
          if (next) setContainer(trigger.current?.closest('dialog') ?? null);
          setOpen(next);
        }}
        onValueChange={(next) => {
          const nextValue = next === EMPTY_OPTION ? '' : next;
          if (value === undefined) setInternal(nextValue);
          onValueChange?.(nextValue);
        }}
      >
        <SelectPrimitive.Trigger
          {...triggerProps}
          ref={trigger}
          className={`select-trigger ${className}`}
        >
          <SelectPrimitive.Value placeholder={placeholder || empty?.label || '请选择'}>
            {text}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <ChevronDown size={16} className="select-chevron" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={container}>
          <SelectPrimitive.Content
            className="select-content"
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            align="start"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus({ preventScroll: true });
            }}
          >
            <SelectPrimitive.ScrollUpButton className="select-scroll-button">
              <ChevronUp size={15} />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="select-viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  className="select-option"
                  key={option.value}
                  value={option.value || EMPTY_OPTION}
                  disabled={option.disabled || (!!required && !option.value)}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="select-indicator">
                    <Check size={14} strokeWidth={2} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="select-scroll-button">
              <ChevronDown size={15} />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
  }
>(function Button(
  { variant = 'primary', size = 'md', loading, children, className = '', disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`button button-${variant} button-${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
});

/** Square icon-only button. The label is both its accessible name and its tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    tooltip?: boolean;
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
    size?: 'sm' | 'md';
  }
>(function IconButton(
  { label, tooltip = true, tooltipSide = 'top', size = 'md', className = '', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tooltip={tooltip ? label : undefined}
      data-tooltip-side={tooltip ? tooltipSide : undefined}
      className={`icon-button icon-button-${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

/** Adds a lightweight, CSS-rendered tooltip to any focusable element. */
export function Tooltip({
  content,
  side = 'top',
  children,
}: {
  content: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement<Record<string, unknown>>;
}) {
  return cloneElement(children, { 'data-tooltip': content, 'data-tooltip-side': side });
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const opener = document.activeElement as HTMLElement | null;
      dialog.showModal();
      dialog
        .querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]), button[role="combobox"]:not([disabled])',
        )
        ?.focus({ preventScroll: true });
      const previous = document.body.style.overflow;
      const previousPadding = document.body.style.paddingRight;
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      if (!CSS.supports('scrollbar-gutter: stable') && scrollbarWidth > 0) {
        const padding = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
        document.body.style.paddingRight = `${padding + scrollbarWidth}px`;
      }
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
        document.body.style.paddingRight = previousPadding;
        if (dialog.open) dialog.close();
        // Return focus to whatever opened the dialog, when it still exists.
        if (opener && opener.isConnected && opener !== document.body)
          opener.focus({ preventScroll: true });
      };
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // Keep keyboard focus cycling inside the dialog, including in browsers whose
        // native modal dialogs let Tab reach the address bar.
        if (e.key !== 'Tab') return;
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button aria-label="关闭窗口" className="icon-button icon-button-sm" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const fieldId = useId();
  let count = 0;
  let firstId: string | undefined;
  function connect(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement<Record<string, unknown>>(node)) return node;
      if (
        node.type === Select ||
        (typeof node.type === 'string' && ['input', 'textarea', 'select'].includes(node.type))
      ) {
        const id = typeof node.props.id === 'string' ? node.props.id : `${fieldId}-${count++}`;
        firstId ??= id;
        return cloneElement(node, {
          id,
          'aria-labelledby': `${fieldId}-label`,
          ...(hint ? { 'aria-describedby': `${fieldId}-hint` } : {}),
        });
      }
      return node.props.children
        ? cloneElement(node, {}, connect(node.props.children as ReactNode))
        : node;
    });
  }
  const controls = connect(children);
  return (
    <div className="field">
      <label id={`${fieldId}-label`} htmlFor={firstId} className="field-label">
        {label}
      </label>
      {controls}
      {hint && <small id={`${fieldId}-hint`}>{hint}</small>}
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'empty-state-compact' : ''}`}>
      <div className="empty-icon" aria-hidden="true">
        {icon || <NotebookPen size={22} strokeWidth={1.6} />}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
export type BadgeTone =
  | 'green'
  | 'pink'
  | 'amber'
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';
export function Badge({
  children,
  tone = 'neutral',
  dot,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
export function Avatar({
  name,
  src,
  color,
  size = 'normal',
}: {
  name: string;
  src?: string;
  color?: string;
  size?: 'xs' | 'small' | 'normal' | 'large';
}) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={color ? ({ '--avatar-color': color } as CSSProperties) : undefined}
    >
      {src ? (
        <img
          key={src}
          src={src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <span aria-hidden={src ? true : undefined}>{name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}

/** A bordered surface with an optional header row. */
export function Card({
  title,
  description,
  icon,
  actions,
  children,
  className = '',
  as: Tag = 'section',
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div' | 'aside';
}) {
  return (
    <Tag className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-header-text">
            {title && (
              <h2 className="card-title">
                {icon}
                {title}
              </h2>
            )}
            {description && <p className="card-description">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

export function Skeleton({
  width,
  height = 12,
  radius,
  className = '',
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton ${className}`}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role={label ? 'status' : undefined}>
      <LoaderCircle size={size} className="spin" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const Icon =
    tone === 'success'
      ? CheckCircle2
      : tone === 'warning'
        ? TriangleAlert
        : tone === 'danger'
          ? CircleAlert
          : Info;
  return (
    <div className={`notice notice-${tone}`} role={role}>
      <Icon size={17} aria-hidden="true" />
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
