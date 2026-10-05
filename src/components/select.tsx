'use client';

import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useId,
  useState,
  type ReactNode,
} from 'react';
import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

interface Option {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}
interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  'aria-label'?: string;
  variant?: 'default' | 'compact' | 'minimal';
  align?: 'start' | 'center' | 'end';
}

// Keep option declarations next to their form while sharing one accessible,
// fully themed popup implementation across every platform and admin page.
function optionsFrom(children: ReactNode): Option[] {
  const options: Option[] = [];
  Children.forEach(children, (child) => {
    if (
      !isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)
    )
      return;
    if (child.type === Fragment) options.push(...optionsFrom(child.props.children));
    else if (child.type === 'option')
      options.push({
        value: String(child.props.value ?? ''),
        label: child.props.children,
        disabled: child.props.disabled,
      });
  });
  return options;
}

export function Select({
  value,
  onValueChange,
  children,
  id,
  name,
  disabled,
  required,
  className = '',
  'aria-label': label,
  variant = 'default',
  align = 'start',
}: SelectProps) {
  const generatedId = useId();
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  const [keyboard, setKeyboard] = useState(false);
  const triggerRef = useCallback((node: HTMLButtonElement | null) => {
    if (node) setContainer(node.closest<HTMLElement>('dialog, [role="dialog"]') || undefined);
  }, []);
  const options = optionsFrom(children);
  const emptyOption = options.find((option) => option.value === '');
  const placeholderOnly = !!emptyOption?.disabled;
  const emptyValue = `__empty_${generatedId}`;
  const encode = (input: string) => (input === '' ? (placeholderOnly ? '' : emptyValue) : input);
  return (
    <Primitive.Root
      value={encode(value)}
      onValueChange={(next) => onValueChange(next === emptyValue ? '' : next)}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      required={required}
    >
      {name && <input type="hidden" name={name} value={value} />}
      <Primitive.Trigger
        ref={triggerRef}
        id={id || generatedId}
        aria-label={label}
        className={`pony-select-trigger select-${variant} ${className}`}
        onPointerDown={() => setKeyboard(false)}
        onKeyDown={() => setKeyboard(true)}
      >
        <Primitive.Value placeholder={emptyOption?.label || '请选择'} />
        <Primitive.Icon className="pony-select-chevron">
          <ChevronDown size={15} strokeWidth={1.6} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content
          className="pony-select-content"
          position="popper"
          sideOffset={7}
          align={align}
          collisionPadding={12}
          data-instant={keyboard ? '' : undefined}
          data-pony-select-menu=""
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setKeyboard(true);
            setOpen(false);
          }}
        >
          <Primitive.ScrollUpButton className="pony-select-scroll">
            <ChevronUp size={14} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="pony-select-viewport">
            {options
              .filter((option) => !(option.value === '' && placeholderOnly))
              .map((option) => (
                <Primitive.Item
                  className="pony-select-item"
                  value={encode(option.value)}
                  key={option.value}
                  disabled={option.disabled}
                >
                  <span className="pony-select-check">
                    <Primitive.ItemIndicator>
                      <Check size={14} strokeWidth={1.8} />
                    </Primitive.ItemIndicator>
                  </span>
                  <Primitive.ItemText>{option.label}</Primitive.ItemText>
                  <span className="pony-select-item-dot" aria-hidden="true" />
                </Primitive.Item>
              ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="pony-select-scroll">
            <ChevronDown size={14} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
