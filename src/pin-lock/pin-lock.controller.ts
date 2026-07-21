import { Body, Controller, Get, Post, Render, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PinLockService } from './pin-lock.service';

@Controller('pin')
export class PinLockController {
  constructor(private readonly pinLockService: PinLockService) {}

  @Get()
  @Render('pin-lock')
  async unlockForm() {
    return {
      pinConfigured: await this.pinLockService.isConfigured(),
    };
  }

  @Post()
  async unlock(
    @Body() body: { pin?: string },
    @Res() reply: FastifyReply,
  ): Promise<any> {
    const pin = String(body.pin ?? '').trim();
    if (!(await this.pinLockService.verifyPin(pin))) {
      return reply.view('pin-lock', {
        layout: 'layout',
        pinConfigured: await this.pinLockService.isConfigured(),
        error: 'Incorrect PIN',
        ...((reply as any).locals ?? {}),
      });
    }

    reply.setCookie('wardrobe_pin_unlock', await this.pinLockService.unlockToken(), {
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: true,
      sameSite: 'lax',
    });
    return reply.redirect('/wardrobe', 302);
  }

  @Post('lock')
  lock(@Res() reply: FastifyReply) {
    reply.clearCookie('wardrobe_pin_unlock', { path: '/' });
    return reply.redirect('/pin', 302);
  }
}
