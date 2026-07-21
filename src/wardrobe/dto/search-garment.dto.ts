import { GarmentColor } from '../garment-color.enum';

export interface SearchGarmentDto {
  keyword?: string;
  category?: string;
  color?: GarmentColor | string;
  brand?: string;
  size?: string;
  location?: string;
  tag?: string;
  archived?: string;
}
