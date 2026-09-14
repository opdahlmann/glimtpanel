import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PrefsService } from '@core/prefs.service';
import { PushService } from '@core/push.service';
import { PwaService } from '@core/pwa.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { LogoComponent } from '@shared/logo/logo.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { TitleService } from '../../shell/title.service';

/**
 * Første gang på telefonen (steg 7.5, skjerm 14): logo 56, «Get alerts on your phone», to nummererte trinn (hjemskjerm,
 * varsler), på desktop et glasskort med «Install» (`beforeinstallprompt`), hvit knapp «Turn on notifications» (48 px),
 * ghost «Later». Etter samtykke: grønn pille «Notifications are on for this device». På iPhone uten hjemskjerm er
 * trinn 1 fremhevet og knappen forklarer at hjemskjermen kreves (`navigator.standalone === false`).
 * Vises første gang appen åpnes på mobil etter innlogging (`PrefsService.welcomeSeen`), og fra «Show me».
 */
@Component({
  selector: 'gp-welcome-page',
  imports: [TPipe, ButtonComponent, LogoComponent],
  templateUrl: './welcome.page.html',
  styleUrl: './welcome.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WelcomePage {
  readonly push = inject(PushService);
  readonly pwa = inject(PwaService);
  private readonly prefs = inject(PrefsService);
  private readonly router = inject(Router);
  readonly isMobile = inject(BreakpointService).isMobile;

  readonly needsHomeScreen = this.pwa.iosNeedsHomeScreen;
  /** Desktop-banneret: Chromium som tilbyr installasjon, og ikke allerede installert. */
  readonly showInstall = computed(() => !this.isMobile() && !this.pwa.standalone() && (this.pwa.canInstall() || this.pwa.installed()));
  readonly done = this.push.isOn;
  readonly denied = computed(() => this.push.status() === 'denied');
  readonly unsupported = computed(() => this.push.status() === 'unsupported');
  readonly asking = computed(() => this.push.status() === 'asking');
  readonly failed = computed(() => this.push.status() === 'error');

  constructor() {
    inject(TitleService).setKey('pwaTitle');
    this.prefs.welcomeSeen.set(true);
  }

  async enable(): Promise<void> {
    await this.push.enable();
  }

  install(): void {
    void this.pwa.install();
  }

  later(): void {
    void this.router.navigate(['/']);
  }
}
