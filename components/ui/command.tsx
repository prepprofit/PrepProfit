'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * shadcn-style command primitives on cmdk (Sprint 2.7), themed to PrepProfit tokens.
 * The ⌘K palette drives these in controlled `shouldFilter={false}` mode.
 */
const Command = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-2xl bg-surface text-foreground', className)}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-3 border-b border-border px-4">
    <Search className="size-5 shrink-0 text-accent-500" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-14 w-full bg-transparent text-base text-foreground outline-none',
        'placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-[50vh] overflow-y-auto overflow-x-hidden p-1.5', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground',
      /* Group heading: small-caps label, well separated from items */
      '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3',
      '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold',
      '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest',
      '[&_[cmdk-group-heading]]:text-muted-foreground/60',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'group relative flex cursor-pointer select-none items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none',
      'transition-colors duration-100',
      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      'data-[selected=true]:bg-surface-2 data-[selected=true]:text-foreground',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export { Command, CommandInput, CommandList, CommandGroup, CommandItem };
