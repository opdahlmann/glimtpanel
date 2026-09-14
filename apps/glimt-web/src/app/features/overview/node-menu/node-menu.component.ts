import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorKey } from '@core/api.service';
import { GroupsStore } from '@core/groups.store';
import { I18nKey } from '@core/i18n.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { BreakpointService } from '@shared/util/breakpoint.service';

/**
 * ⋯-menyen på et nodekort (steg 13.2): «Add to group…» med brukerens grupper og en hake per gruppe noden står i,
 * og «New group…» med navnefelt som oppretter gruppen med noden som første medlem. Åpnes med Enter/klikk på ⋯
 * (32 px, 44 px treffflate) og lukkes med Esc. Menyen er en liten dialog på desktop og et bunnark på mobil, så den
 * aldri klippes av kortets `overflow: hidden`. Demokontoen får se menyen som lesbar, uten å kunne endre.
 */
@Component({
  selector: 'gp-node-menu',
  imports: [ModalComponent, InputComponent, ButtonComponent, FormsModule, TPipe],
  template: `
    <button type="button" class="more" (click)="toggle($event)" [attr.aria-label]="('nodeActions' | t) + ' ' + name()" [attr.aria-expanded]="open()" aria-haspopup="dialog">
      <span class="dots" aria-hidden="true"></span>
    </button>
    <gp-modal [(open)]="open" [title]="name()" [maxWidth]="440" [sheet]="isMobile()" [closeLabel]="'close' | t">
      @if (open()) {
        <div class="section">{{ 'addToGroup' | t }}</div>
        <div class="items" role="group" [attr.aria-label]="'addToGroup' | t">
          @for (g of groups(); track g.id) {
            <button type="button" class="item" role="menuitemcheckbox" [attr.aria-checked]="g.member" [disabled]="readOnly() || busy()" (click)="toggleGroup(g.id)">
              <span class="check" aria-hidden="true">{{ g.member ? '✓' : '' }}</span>
              <span class="gname">{{ g.name }}</span>
            </button>
          } @empty {
            @if (!creating()) {
              <div class="hint">{{ 'noGroupsYet' | t }}</div>
            }
          }
        </div>
        @if (creating()) {
          <div class="new">
            <gp-input [label]="'groupName' | t" [ngModel]="newName()" (ngModelChange)="newName.set($event)" name="groupName" autocomplete="off" (keydown.enter)="create()" (keydown.escape)="cancelCreate($event)" />
            <div class="row">
              <gp-button variant="ghost" (click)="creating.set(false)">{{ 'cancel' | t }}</gp-button>
              <gp-button variant="primary" [loading]="busy()" [disabled]="!newName().trim()" (click)="create()">{{ 'createNode' | t }}</gp-button>
            </div>
          </div>
        } @else if (!readOnly()) {
          <button type="button" class="item add" (click)="startCreate()"><span class="check" aria-hidden="true">+</span><span class="gname">{{ 'newGroup' | t }}</span></button>
        }
        @if (readOnly()) {
          <div class="hint">{{ 'demoReadOnly' | t }}</div>
        }
        @if (error(); as e) {
          <div class="error" role="alert">{{ e | t }}</div>
        }
      }
    </gp-modal>
  `,
  styles: `
    :host { display: inline-flex; }
    .more {
      display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin: -6px -8px -6px 0; padding: 0;
      background: none; border: 0; color: var(--w-60); cursor: pointer; border-radius: 50%;
    }
    .dots { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; font-size: 16px; line-height: 1; transition: background var(--t-hover), color var(--t-hover); }
    .dots::before { content: '⋯'; }
    .more:hover .dots, .more:focus-visible .dots { background: var(--s-8); color: var(--w-100); }
    .section { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--w-55); }
    .items { display: flex; flex-direction: column; gap: 2px; }
    .item {
      display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 10px; border: 0; border-radius: var(--radius-chip);
      background: transparent; color: var(--w-85); font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; width: 100%;
      transition: background var(--t-hover);
    }
    .item:hover:not(:disabled) { background: var(--s-5); }
    .item:disabled { cursor: default; opacity: .7; }
    .item[aria-checked="true"] { color: var(--w-100); }
    .check { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; background: var(--s-8); font-size: 12px; flex: none; }
    .item[aria-checked="true"] .check { background: var(--color-cpu); color: var(--color-ink); }
    .add { color: var(--w-60); }
    .gname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .new { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .hint { font-size: 11px; color: var(--w-45); padding: 6px 10px; }
    .error { font-size: 11px; color: var(--color-crit); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeMenuComponent {
  readonly id = input.required<string>();
  readonly name = input('');

  private readonly store = inject(GroupsStore);
  readonly isMobile = inject(BreakpointService).isMobile;

  readonly open = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly readOnly = this.store.readOnly;
  readonly groups = computed(() => this.store.groups().map((g) => ({ id: g.id, name: g.name, member: g.memberIds.includes(this.id()) })));

  toggle(e: Event): void {
    e.stopPropagation();
    this.error.set(null);
    this.creating.set(false);
    this.open.update((v) => !v);
    if (this.open() && !this.store.loaded()) void this.store.load().catch(() => undefined);
  }

  async toggleGroup(groupId: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.toggleMember(groupId, this.id());
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  startCreate(): void {
    this.newName.set('');
    this.error.set(null);
    this.creating.set(true);
  }

  cancelCreate(e: Event): void {
    e.stopPropagation();
    this.creating.set(false);
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.create(name, [this.id()]);
      this.creating.set(false);
      this.newName.set('');
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }
}
