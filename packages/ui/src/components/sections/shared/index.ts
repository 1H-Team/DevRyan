/**
 * Shared boilerplate components for settings sections.
 *
 * These components provide consistent styling and behavior for settings sidebars and pages.
 * Use them as building blocks when creating new settings sections.
 *
 * @example Sidebar usage:
 * ```tsx
 * import {
 *   SettingsSidebarLayout,
 *   SettingsSidebarHeader,
 *   SettingsSidebarItem,
 * } from '@/components/sections/shared';
 *
 * export const MySidebar = () => (
 *   <SettingsSidebarLayout
 *     header={<SettingsSidebarHeader count={items.length} onAdd={handleAdd} />}
 *   >
 *     {items.map(item => (
 *       <SettingsSidebarItem
 *         key={item.id}
 *         title={item.name}
 *         metadata={item.description}
 *         selected={selectedId === item.id}
 *         onSelect={() => setSelectedId(item.id)}
 *         actions={[
 *           { label: 'Delete', onClick: () => handleDelete(item.id), destructive: true }
 *         ]}
 *       />
 *     ))}
 *   </SettingsSidebarLayout>
 * );
 * ```
 *
 * @example Page usage:
 * ```tsx
 * import { SettingsPageLayout, SettingsSection } from '@/components/sections/shared';
 *
 * export const MyPage = () => (
 *   <SettingsPageLayout>
 *     <SettingsSection title="General Settings">
 *       <MySettingsForm />
 *     </SettingsSection>
 *     <SettingsSection title="Advanced" divider>
 *       <AdvancedSettingsForm />
 *     </SettingsSection>
 *   </SettingsPageLayout>
 * );
 * ```
 *
 * @example Preference rows:
 * ```tsx
 * import { SettingsDetailSection, SettingsField, SettingsSwitchField } from '@/components/sections/shared';
 *
 * <SettingsDetailSection title="Layout" description="Chat width and spacing.">
 *   <SettingsSwitchField label="Sticky User Header" description="Pins your message while you scroll." checked={on} onCheckedChange={setOn} />
 *   <SettingsField label="Code Font" description="Used for code blocks." reset={reset}>
 *     {({ labelId, describedBy }) => <Select aria-labelledby={labelId} aria-describedby={describedBy} />}
 *   </SettingsField>
 * </SettingsDetailSection>
 * ```
 */

export { SettingsSidebarLayout } from './SettingsSidebarLayout';
export { SettingsSidebarHeader } from './SettingsSidebarHeader';
export { SettingsSidebarItem, type SettingsSidebarItemAction } from './SettingsSidebarItem';
export { SettingsPageLayout } from './SettingsPageLayout';
export { SettingsSection } from './SettingsSection';
export { SidebarGroup } from './SidebarGroup';
export { SettingsEmptyState } from './SettingsEmptyState';
export { SettingsDetailHeader } from './SettingsDetailHeader';
export { SettingsDetailSection } from './SettingsDetailSection';
export { SettingsBadge, type SettingsBadgeTone } from './SettingsBadge';
export {
  SettingsField,
  SettingsResetButton,
  SettingsSwitchField,
  type SettingsFieldControlProps,
  type SettingsResetAction,
} from './SettingsField';
export { SettingsOptionCardGroup, type SettingsOptionCard } from './SettingsOptionCardGroup';
