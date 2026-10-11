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
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronUp, LoaderCircle, X, Sparkles } from 'lucide-react';
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

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    loading?: boolean;
  }
>(function Button(
  { variant = 'primary', loading, children, className = '', disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`button button-${variant} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
});

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
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog
        .querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]), button[role="combobox"]:not([disabled])',
        )
        ?.focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
    if (open) {
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
      };
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={title.replace(/\s/g, '')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
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
          <span className="eyebrow">CHATPONY</span>
          <h2 id={title.replace(/\s/g, '')}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button aria-label="关闭窗口" className="icon-button" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
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
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Sparkles size={25} strokeWidth={1.4} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'green' | 'pink' | 'amber' | 'neutral';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
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
  size?: 'small' | 'normal' | 'large';
}) {
  return (
    <span className={`avatar avatar-${size}`} style={{ backgroundColor: color || '#e7efe5' }}>
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
      <span>{name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
