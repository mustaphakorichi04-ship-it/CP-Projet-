import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService, RegisterTenantDto, LoginDto } from './auth.service';
import { Public } from './decorators/public.decorator';
import { AuthGuard } from './guards/auth.guard';
import { UserSessionDto } from '@cp-engineer/shared-types';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setSessionCookie(res: Response, token: string) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('cp_session', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
      path: '/',
    });
  }

  @Public()
  @Post('register-tenant')
  async registerTenant(
    @Body() dto: RegisterTenantDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.authService.registerTenant(dto);
    this.setSessionCookie(res, token);
    return { success: true, user };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.authService.login(dto);
    this.setSessionCookie(res, token);
    return { success: true, user };
  }

  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('cp_session', {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    return { success: true, message: 'Déconnexion réussie.' };
  }

  @UseGuards(AuthGuard)
  @Get('me')
  async getProfile(@Req() req: Request): Promise<UserSessionDto> {
    return (req as any).user;
  }
}
