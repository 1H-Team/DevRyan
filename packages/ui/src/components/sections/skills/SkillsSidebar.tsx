import React, { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { isMobileDeviceViaCSS } from '@/lib/device';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiAddLine, RiDeleteBinLine, RiFileCopyLine, RiMore2Line, RiEditLine, RiBookOpenLine, RiEyeOffLine, RiSearchLine, RiCloseLine } from '@remixicon/react';
import { getSkillIdentity, useSkillsStore, type DiscoveredSkill } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SkillFolderGroup, SkillLocationGroup } from './SkillTreeGroup';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { locationValueFrom, type SkillLocationValue } from './skillLocations';
import { filterSkillsForSidebar, groupSkillsForSidebar, sortSkillsForSidebar, formatSkillFolderLabel } from './skillSidebarGrouping';
import { canEditSettingsPage, canReadSettingsPage, useAuthPrincipal } from '@/lib/authSession';

interface SkillsSidebarProps {
  onItemSelect?: () => void;
}

export const SkillsSidebar: React.FC<SkillsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const canReadCatalog = canReadSettingsPage(principal, 'skills.catalog');
  const canEditSkills = canEditSettingsPage(principal, 'skills.installed');
  const [renameDialogSkill, setRenameDialogSkill] = React.useState<DiscoveredSkill | null>(null);
  const [renameNewName, setRenameNewName] = React.useState('');
  const [deleteDialogSkill, setDeleteDialogSkill] = React.useState<DiscoveredSkill | null>(null);
  const [isDeletePending, setIsDeletePending] = React.useState(false);
  const [openMenuSkill, setOpenMenuSkill] = React.useState<string | null>(null);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const selectedCatalogSourceId = useSkillsCatalogStore((state) => state.selectedSourceId);
  const loadCatalogSource = useSkillsCatalogStore((state) => state.loadSource);

  const locationLabelText = React.useCallback((value: SkillLocationValue) => {
    switch (value) {
      case 'project-opencode':
        return t('settings.skills.location.option.projectOpencode.label');
      case 'user-agents':
        return t('settings.skills.location.option.userAgents.label');
      case 'project-agents':
        return t('settings.skills.location.option.projectAgents.label');
      default:
        return t('settings.skills.location.option.userOpencode.label');
    }
  }, [t]);

  const {
    selectedSkillName,
    selectedSkillIdentity,
    skills,
    setSelectedSkill,
    setSkillDraft,
    createSkill,
    hideSkill,
    deleteSkill,
    getSkillDetail,
  } = useSkillsStore(useShallow((s) => ({
    selectedSkillName: s.selectedSkillName,
    selectedSkillIdentity: s.selectedSkillIdentity,
    skills: s.skills,
    setSelectedSkill: s.setSelectedSkill,
    setSkillDraft: s.setSkillDraft,
    createSkill: s.createSkill,
    hideSkill: s.hideSkill,
    deleteSkill: s.deleteSkill,
    getSkillDetail: s.getSkillDetail,
  })));

  // Skills are loaded by the Settings shell when this page is active.

  const bgClass = 'bg-background';

  const handleCreateNew = () => {
    // Generate unique name
    const baseName = 'new-skill';
    let newName = baseName;
    let counter = 1;
    while (skills.some((s) => s.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    // Set draft and open the page for editing
    setSkillDraft({ name: newName, scope: 'user', source: 'opencode', description: '' });
    setSelectedSkill(newName);
    onItemSelect?.();


  };

  const handleDeleteSkill = (skill: DiscoveredSkill) => {
    setDeleteDialogSkill(skill);
  };

  const handleHideSkill = async (skill: DiscoveredSkill) => {
    const success = await hideSkill(skill);
    if (success) {
      toast.success(t('settings.skills.sidebar.toast.skillHidden', { name: skill.name }));
      if (selectedCatalogSourceId) {
        void loadCatalogSource(selectedCatalogSourceId, { refresh: true });
      }
      return;
    }
    toast.error(t('settings.skills.sidebar.toast.hideSkillFailed'));
  };

  const handleConfirmDeleteSkill = async () => {
    if (!deleteDialogSkill) {
      return;
    }

    setIsDeletePending(true);
    const success = await deleteSkill(deleteDialogSkill);
    if (success) {
      toast.success(t('settings.skills.sidebar.toast.skillDeleted', { name: deleteDialogSkill.name }));
      if (selectedCatalogSourceId) {
        void loadCatalogSource(selectedCatalogSourceId, { refresh: true });
      }
      setDeleteDialogSkill(null);
    } else {
      toast.error(t('settings.skills.sidebar.toast.deleteSkillFailed'));
    }
    setIsDeletePending(false);
  };

  const handleDuplicateSkill = async (skill: DiscoveredSkill) => {
    const baseName = skill.name;
    let copyNumber = 1;
    let newName = `${baseName}-copy`;

    while (skills.some((s) => s.name === newName)) {
      copyNumber++;
      newName = `${baseName}-copy-${copyNumber}`;
    }

    setSelectedSkill(skill);
    // Get full skill detail to copy
    const detail = await getSkillDetail(skill.name);
    if (!detail) {
      toast.error(t('settings.skills.sidebar.toast.duplicateLoadFailed'));
      return;
    }

    // Set draft with prefilled values from source skill
      setSkillDraft({
        name: newName,
        scope: 'user',
        source: 'opencode',
        description: detail.sources.md.fields.includes('description') ? '' : '', // Will be populated from page
        instructions: '',
      });
    setSelectedSkill(newName);


  };

  const handleOpenRenameDialog = (skill: DiscoveredSkill) => {
    setRenameNewName(skill.name);
    setRenameDialogSkill(skill);
  };

  const handleRenameSkill = async () => {
    if (!renameDialogSkill) return;

    const sanitizedName = renameNewName.trim().replace(/\s+/g, '-').toLowerCase();

    if (!sanitizedName) {
      toast.error(t('settings.skills.page.toast.skillNameRequired'));
      return;
    }

    if (sanitizedName === renameDialogSkill.name) {
      setRenameDialogSkill(null);
      return;
    }

    if (skills.some((s) => s.name === sanitizedName)) {
      toast.error(t('settings.skills.page.toast.skillExists'));
      return;
    }

    setSelectedSkill(renameDialogSkill);
    // Get full detail to copy
    const detail = await getSkillDetail(renameDialogSkill.name);
    if (!detail) {
      toast.error(t('settings.skills.sidebar.toast.renameLoadFailed'));
      setRenameDialogSkill(null);
      return;
    }

    // Create new skill with new name
    const success = await createSkill({
      name: sanitizedName,
      description: 'Renamed skill', // Will need proper description
      scope: renameDialogSkill.scope,
      source: renameDialogSkill.source,
    });

    if (success) {
      // Delete old skill
      const deleteSuccess = await deleteSkill(renameDialogSkill);
      if (deleteSuccess) {
        toast.success(`Skill renamed to "${sanitizedName}"`);
        setSelectedSkill(sanitizedName);
      } else {
        toast.error(t('settings.skills.sidebar.toast.removeOldAfterRenameFailed'));
      }
    } else {
      toast.error(t('settings.skills.sidebar.toast.renameFailed'));
    }

    setRenameDialogSkill(null);
  };

  const [searchQuery, setSearchQuery] = React.useState('');
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  const groupedSkills = useMemo(() => groupSkillsForSidebar(skills, locationLabelText), [skills, locationLabelText]);
  const searchResults = useMemo(
    () => (isSearching ? sortSkillsForSidebar(filterSkillsForSidebar(skills, trimmedQuery)) : []),
    [isSearching, skills, trimmedQuery],
  );

  // Leaving search rebuilds the tree; bump a nonce so the folder holding the skill
  // the user just picked from the results opens instead of hiding it again.
  const [revealNonce, setRevealNonce] = React.useState(0);
  const wasSearching = React.useRef(isSearching);
  React.useEffect(() => {
    if (wasSearching.current && !isSearching) {
      setRevealNonce((nonce) => nonce + 1);
    }
    wasSearching.current = isSearching;
  }, [isSearching]);

  const isSkillSelected = React.useCallback(
    (skill: DiscoveredSkill) => (selectedSkillIdentity
      ? getSkillIdentity(skill) === selectedSkillIdentity
      : selectedSkillName === skill.name),
    [selectedSkillIdentity, selectedSkillName],
  );

  const renderSkillRow = (skill: DiscoveredSkill, options: { nested?: boolean; context?: string } = {}) => (
    <SkillListItem
      key={skill.path || skill.name}
      skill={skill}
      nested={options.nested}
      context={options.context}
      isSelected={isSkillSelected(skill)}
      onSelect={() => {
        setSelectedSkill(skill);
        onItemSelect?.();
      }}
      onRename={() => handleOpenRenameDialog(skill)}
      onHide={() => void handleHideSkill(skill)}
      onDelete={() => handleDeleteSkill(skill)}
      onDuplicate={() => handleDuplicateSkill(skill)}
      isMenuOpen={openMenuSkill === getSkillIdentity(skill)}
      onMenuOpenChange={(open) => setOpenMenuSkill(open ? getSkillIdentity(skill) : null)}
    />
  );

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground truncate">{t('settings.skills.sidebar.title')}</h2>
          <div className="flex items-center gap-1">
            {canReadCatalog ? <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-7 gap-1.5 !font-normal normal-case"
              onClick={() => {
                setSettingsPage('skills.catalog');
                onItemSelect?.();
              }}
            >
              <RiBookOpenLine className="h-3.5 w-3.5" />
              {t('settings.page.skillsCatalog.title')}
            </Button> : null}
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 -my-1 text-muted-foreground"
              onClick={handleCreateNew}
              disabled={!canEditSkills}
            >
              <RiAddLine className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {skills.length > 0 ? (
          <div className="relative mt-3">
            <RiSearchLine className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('settings.skills.sidebar.field.searchPlaceholder')}
              className="h-7 pl-7 pr-7 [&::-webkit-search-cancel-button]:appearance-none"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchQuery('');
                }
              }}
            />
            {isSearching ? (
              <button
                type="button"
                aria-label={t('settings.skills.sidebar.search.clearAria')}
                onClick={() => setSearchQuery('')}
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <RiCloseLine className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        <span className="typography-meta text-muted-foreground mt-2 block">
          {isSearching
            ? t('settings.skills.sidebar.search.matchCount', { count: searchResults.length, total: skills.length })
            : t('settings.skills.sidebar.total', { count: skills.length })}
        </span>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {skills.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiBookOpenLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.skills.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.skills.sidebar.empty.description')}</p>
          </div>
        ) : isSearching ? (
          searchResults.length === 0 ? (
            <div className="py-12 px-4 text-center text-muted-foreground">
              <RiSearchLine className="mx-auto mb-3 h-8 w-8 opacity-40" />
              <p className="typography-ui-label font-medium">{t('settings.skills.sidebar.search.empty.title')}</p>
              <p className="typography-meta mt-1 opacity-75">{t('settings.skills.sidebar.search.empty.description')}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {searchResults.map((skill) => renderSkillRow(skill, {
                context: [
                  skill.group ? formatSkillFolderLabel(skill.group) : null,
                  locationLabelText(locationValueFrom(skill.scope, skill.source)),
                ].filter(Boolean).join(' · '),
              }))}
            </div>
          )
        ) : (
          <>
            {groupedSkills.map(({ key: groupKey, label: groupLabel, directSkills, folderGroups, count }) => (
              <SkillLocationGroup
                key={groupKey}
                label={groupLabel}
                count={count}
                storageKey="skills"
              >
                {directSkills.map((skill) => renderSkillRow(skill))}
                {folderGroups.map((folderGroup) => (
                  <SkillFolderGroup
                    key={`${groupKey}:${folderGroup.key}`}
                    label={folderGroup.label}
                    count={folderGroup.skills.length}
                    storageKey={`skills:${groupKey}:folders`}
                    containsSelected={folderGroup.skills.some(isSkillSelected)}
                    revealNonce={revealNonce}
                  >
                    {folderGroup.skills.map((skill) => renderSkillRow(skill, { nested: true }))}
                  </SkillFolderGroup>
                ))}
              </SkillLocationGroup>
            ))}
          </>
        )}
      </ScrollableOverlay>

      <Dialog
        open={deleteDialogSkill !== null}
        onOpenChange={(open) => {
          if (!open && !isDeletePending) {
            setDeleteDialogSkill(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.skills.sidebar.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.sidebar.deleteDialog.description', { name: deleteDialogSkill?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              className="text-foreground hover:bg-interactive-hover hover:text-foreground"
              variant="ghost"
              onClick={() => setDeleteDialogSkill(null)}
              disabled={isDeletePending}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirmDeleteSkill} disabled={isDeletePending}>
              {t('settings.common.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogSkill !== null} onOpenChange={(open) => !open && setRenameDialogSkill(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.skills.sidebar.renameDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.sidebar.renameDialog.description', { name: renameDialogSkill?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            placeholder={t('settings.skills.sidebar.renameDialog.placeholder')}
            className="text-foreground placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRenameSkill();
              }
            }}
          />
          <DialogFooter>
            <Button
              size="sm"
              className="text-foreground hover:bg-interactive-hover hover:text-foreground"
              variant="ghost"
              onClick={() => setRenameDialogSkill(null)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleRenameSkill}>
              {t('settings.common.actions.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface SkillListItemProps {
  skill: DiscoveredSkill;
  /** Secondary line describing where the skill lives — only used in search results,
   *  where the grouped headers that normally carry this are not rendered. */
  context?: string;
  /** Rows inside a folder already sit behind a guide rail, so they carry the
   *  selection accent inline instead of on the container's left edge. */
  nested?: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onHide: () => void;
  onDelete: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

const SkillListItem: React.FC<SkillListItemProps> = ({
  skill,
  context,
  nested,
  isSelected,
  onSelect,
  onHide,
  onDelete,
  onRename,
  onDuplicate,
  isMenuOpen,
  onMenuOpenChange,
}) => {
  const { t } = useI18n();
  const isMobile = isMobileDeviceViaCSS();
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md py-1 pl-2 pr-1.5 transition-colors duration-150 select-none',
        // Selected rows get an accent rail so the active skill stays findable inside
        // long trees. Inside a folder it lands on the folder's guide line, lighting
        // up the branch that leads to the selection instead of drawing a second bar.
        'before:absolute before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:transition-opacity',
        nested ? 'before:-left-[9px]' : 'before:left-0',
        isSelected
          ? 'bg-interactive-selection before:opacity-100'
          : 'hover:bg-interactive-hover before:opacity-0'
      )}
      onContextMenu={!isMobile ? (e) => {
        e.preventDefault();
        onMenuOpenChange(true);
      } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button
          onClick={onSelect}
          title={skill.description || skill.name}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          tabIndex={0}
        >
          <span
            className={cn(
              'typography-ui-label truncate',
              isSelected ? 'font-medium text-foreground' : 'font-normal text-foreground/90'
            )}
          >
            {skill.name}
          </span>
          {context ? (
            <span className="typography-micro truncate text-muted-foreground">{context}</span>
          ) : null}
        </button>

        <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button size="sm"
              variant="ghost"
              className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
              aria-label={t('settings.skills.sidebar.actions.menuAria', { name: skill.name })}
            >
              <RiMore2Line className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-fit min-w-20">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
            >
              <RiEditLine className="h-4 w-4 mr-px" />
              {t('settings.common.actions.rename')}
            </DropdownMenuItem>

            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
            >
              <RiFileCopyLine className="h-4 w-4 mr-px" />
              {t('settings.common.actions.duplicate')}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              aria-label={t('settings.skills.sidebar.actions.hideAria', { name: skill.name })}
              onClick={(e) => {
                e.stopPropagation();
                onHide();
              }}
            >
              <RiEyeOffLine className="h-4 w-4 mr-px" />
              {t('settings.common.actions.hide')}
            </DropdownMenuItem>

            <DropdownMenuItem
              aria-label={t('settings.skills.sidebar.actions.removeAria', { name: skill.name })}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              variant="destructive"
            >
              <RiDeleteBinLine className="h-4 w-4 mr-px" />
              {t('settings.common.actions.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
