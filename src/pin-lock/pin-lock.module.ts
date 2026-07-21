import { Module } from '@nestjs/common';
import { PinLockController } from './pin-lock.controller';
import { PinLockService } from './pin-lock.service';

@Module({
  controllers: [PinLockController],
  providers: [PinLockService],
  exports: [PinLockService],
})
export class PinLockModule {}
