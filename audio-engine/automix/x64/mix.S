/* Fixed work per sample; unaligned buffers and arbitrary tail sizes supported.
 * Separate multiply/add matches the scalar reference. No clipping or allocation. */
.intel_syntax noprefix
.text
.globl am_k_mix_sse2
.seh_proc am_k_mix_sse2
am_k_mix_sse2:
 .seh_endprologue
 mov r10,QWORD PTR [rsp+40]
 cmp r10,4
 jb .Lsse_tail
.Lsse_loop:
 movups xmm0,XMMWORD PTR [rcx]
 movups xmm1,XMMWORD PTR [rdx]
 movups xmm2,XMMWORD PTR [r8]
 movups xmm3,XMMWORD PTR [r9]
 mulps xmm0,xmm2
 mulps xmm1,xmm3
 addps xmm0,xmm1
 movups XMMWORD PTR [rcx],xmm0
 add rcx,16
 add rdx,16
 add r8,16
 add r9,16
 sub r10,4
 cmp r10,4
 jae .Lsse_loop
.Lsse_tail:
 test r10,r10
 jz .Lsse_return
.Lsse_scalar:
 movss xmm0,DWORD PTR [rcx]
 movss xmm1,DWORD PTR [rdx]
 mulss xmm0,DWORD PTR [r8]
 mulss xmm1,DWORD PTR [r9]
 addss xmm0,xmm1
 movss DWORD PTR [rcx],xmm0
 add rcx,4
 add rdx,4
 add r8,4
 add r9,4
 dec r10
 jnz .Lsse_scalar
.Lsse_return:
 ret
.seh_endproc
.globl am_k_mix_avx2
.seh_proc am_k_mix_avx2
am_k_mix_avx2:
 .seh_endprologue
 mov r10,QWORD PTR [rsp+40]
 cmp r10,8
 jb .Lavx_tail
.Lavx_loop:
 vmovups ymm0,YMMWORD PTR [rcx]
 vmovups ymm1,YMMWORD PTR [rdx]
 vmulps ymm0,ymm0,YMMWORD PTR [r8]
 vmulps ymm1,ymm1,YMMWORD PTR [r9]
 vaddps ymm0,ymm0,ymm1
 vmovups YMMWORD PTR [rcx],ymm0
 add rcx,32
 add rdx,32
 add r8,32
 add r9,32
 sub r10,8
 cmp r10,8
 jae .Lavx_loop
.Lavx_tail:
 test r10,r10
 jz .Lavx_return
.Lavx_scalar:
 vmovss xmm0,DWORD PTR [rcx]
 vmovss xmm1,DWORD PTR [rdx]
 vmulss xmm0,xmm0,DWORD PTR [r8]
 vmulss xmm1,xmm1,DWORD PTR [r9]
 vaddss xmm0,xmm0,xmm1
 vmovss DWORD PTR [rcx],xmm0
 add rcx,4
 add rdx,4
 add r8,4
 add r9,4
 dec r10
 jnz .Lavx_scalar
.Lavx_return:
 vzeroupper
 ret
.seh_endproc
