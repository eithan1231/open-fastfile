// Just enough of d3d11.h for x64-zt's IW6 structs to compile: every use is a pointer.
#pragma once
#include <cstddef>
#include <cstdint>
struct ID3D11Buffer; struct ID3D11ShaderResourceView; struct ID3D11Texture1D; struct ID3D11Texture2D;
struct ID3D11Texture3D; struct ID3D11Resource; struct ID3D11VertexShader; struct ID3D11PixelShader;
struct ID3D11HullShader; struct ID3D11DomainShader; struct ID3D11ComputeShader; struct ID3D11InputLayout;
struct ID3D11DepthStencilState; struct ID3D11BlendState; struct ID3D11RasterizerState; struct ID3D11SamplerState;
struct ID3D11View;
typedef std::uint32_t DXGI_FORMAT;
