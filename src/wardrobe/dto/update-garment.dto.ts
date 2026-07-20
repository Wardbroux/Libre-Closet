import { MultipartFile } from '@fastify/multipart';
import { GarmentColor } from '../garment-color.enum';

export interface UpdateGarmentDto {
  name?: string;
  category?: string;
  brand?: string;
  color?: GarmentColor;
  size?: string;
  location?: string;
  tags?: string;
  notes?: string;
  washingDetails?: string;
  dateAquired?: string;
  files?: AsyncIterableIterator<MultipartFile>;
}
