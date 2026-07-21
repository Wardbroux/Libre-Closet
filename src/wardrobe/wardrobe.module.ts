import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { Garment } from '../dal/entity/garment.entity';
import { GarmentPhoto } from '../dal/entity/garment-photo.entity';
import { Outfit } from '../dal/entity/outfit.entity';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { User } from '../dal/entity/user.entity';
import { WardrobeLocation } from '../dal/entity/wardrobe-location.entity';
import { FileModule } from '../file/file.module';
import { AuthModule } from '../auth/auth.module';
import { WardrobeShareModule } from '../wardrobe-share/wardrobe-share.module';
import { GarmentService } from './garment.service';
import { OutfitService } from './outfit.service';
import { CalendarService } from './calendar.service';
import { WardrobeController } from './wardrobe.controller';

@Module({
  imports: [
    AuthModule,
    FileModule,
    WardrobeShareModule,
    MikroOrmModule.forFeature([
      Garment,
      GarmentPhoto,
      Outfit,
      OutfitCalendar,
      User,
      WardrobeLocation,
    ]),
  ],
  controllers: [WardrobeController],
  providers: [GarmentService, OutfitService, CalendarService],
  exports: [GarmentService, OutfitService, CalendarService],
})
export class WardrobeModule {}
