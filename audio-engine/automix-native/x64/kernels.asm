; Handwritten numerical kernels, Windows x64 ABI. No FMA contraction.
; RCX/RDX/R8/R9 and XMM0..5 are volatile. GEMM saves its nonvolatile GPRs
; and supplies PE unwind records; all other routines are allocation-free leaves.
bits 64
default rel
section .rdata align=32
indices4: dd 0.0,1.0,2.0,3.0
indices8: dd 0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0
one: dd 1.0
half: dd 0.5
minus_half: dd -0.5
log2e: dd 1.4426950408889634
ln2hi: dd 0.693145751953125
ln2lo: dd 0.000001428606765330187
exp_lo: dd -87.0
exp_hi: dd 88.0
e6: dd 0.001388888888888889
e5: dd 0.008333333333333333
e4: dd 0.041666666666666664
e3: dd 0.16666666666666666
erf_p: dd 0.3275911
erf_a1: dd 0.254829592
erf_a2: dd -0.284496736
erf_a3: dd 1.421413741
erf_a4: dd -1.453152027
erf_a5: dd 1.061405429
abs_mask: dd 0x7fffffff
sign_mask: dd 0x80000000
align 16
imaginary_sign: dd 0,0x80000000,0,0x80000000
real_sign: dd 0x80000000,0,0x80000000,0
both_sign: dd 0x80000000,0x80000000,0x80000000,0x80000000
epsilon: dd 1.0e-15
normalisation_floor: dd 1.0e-12
headroom_release: dd 0.3
headroom_attack: dd 0.06
headroom_edge: dd 0.01
negative_max: dd -3.4028234663852886e38
pi_half: dd 1.5707963267948966
sin_c12: dd 0.00000000016059043836821613
sin_c10: dd -0.00000002505210838544172
sin_c8: dd 0.0000027557319223985893
sin_c6: dd -0.0001984126984126984
sin_c4: dd 0.008333333333333333
sin_c2: dd -0.16666666666666666
align 8
double_one: dq 1.0
double_two: dq 2.0
double_ln2: dq 0.6931471805599453094
double_ramp: dq 0.8
double_half: dq 0.5
double_cancellation: dq 0.02
log_c13: dq 0.076923076923076923
log_c11: dq 0.090909090909090909
log_c9: dq 0.111111111111111111
log_c7: dq 0.142857142857142857
log_c5: dq 0.2
log_c3: dq 0.333333333333333333
log_negative_infinity: dd 0xff800000
log_nan: dd 0x7fc00000
section .text align=16
; Ordered double energy decision preserves anti-phase material before the
; analysis model sees it. Every read is bounded by the supplied stereo frames.
global ta_am_downmix_sse2,ta_am_downmix_avx2
ta_am_downmix_sse2:
ta_am_downmix_avx2:
    xorpd xmm0,xmm0
    xorpd xmm1,xmm1
    xorpd xmm2,xmm2
    xor r10d,r10d
.downmix_energy:
    cmp r10,r8
    jae .downmix_select
    movss xmm3,[rdx+r10*8]
    movss xmm4,[rdx+r10*8+4]
    movaps xmm5,xmm3
    addss xmm5,xmm4
    cvtss2sd xmm5,xmm5
    mulsd xmm5,[double_half]
    mulsd xmm5,xmm5
    addsd xmm0,xmm5
    cvtss2sd xmm3,xmm3
    cvtss2sd xmm4,xmm4
    mulsd xmm3,xmm3
    mulsd xmm4,xmm4
    addsd xmm1,xmm3
    addsd xmm2,xmm4
    inc r10
    jmp .downmix_energy
.downmix_select:
    xor r9d,r9d
    comisd xmm2,xmm1
    seta r9b
    maxsd xmm1,xmm2
    mulsd xmm1,[double_cancellation]
    xor r10d,r10d
    comisd xmm0,xmm1
    jb .downmix_channel
.downmix_mid:
    cmp r10,r8
    jae .downmix_done
    movss xmm3,[rdx+r10*8]
    addss xmm3,[rdx+r10*8+4]
    mulss xmm3,[half]
    movss [rcx+r10*4],xmm3
    inc r10
    jmp .downmix_mid
.downmix_channel:
    lea rdx,[rdx+r9*4]
.downmix_channel_loop:
    cmp r10,r8
    jae .downmix_done
    movss xmm3,[rdx+r10*8]
    movss [rcx+r10*4],xmm3
    inc r10
    jmp .downmix_channel_loop
.downmix_done:
    ret

%macro AXPY 2
global ta_am_axpy_%1
ta_am_axpy_%1:
    xor eax,eax
%if %2 = 8
    vbroadcastss ymm2,xmm2
%else
    shufps xmm2,xmm2,0
%endif
%%vector:
    lea r10,[rax+%2]
    cmp r10,r9
    ja %%scalar
%if %2 = 8
    vmulps ymm0,ymm2,[rdx+rax*4]
    vaddps ymm0,ymm0,[rcx+rax*4]
    vmovups [rcx+rax*4],ymm0
%else
    movups xmm0,[rdx+rax*4]
    mulps xmm0,xmm2
    movups xmm1,[rcx+rax*4]
    addps xmm0,xmm1
    movups [rcx+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar:
    cmp rax,r9
    jae %%done
    movss xmm0,[rdx+rax*4]
    mulss xmm0,xmm2
    addss xmm0,[rcx+rax*4]
    movss [rcx+rax*4],xmm0
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
AXPY sse2,4
AXPY avx2,8

%macro DOT 2
global ta_am_dot_%1
ta_am_dot_%1:
    xor eax,eax
%if %2 = 8
    vxorps ymm0,ymm0,ymm0
%else
    xorps xmm0,xmm0
%endif
%%vector:
    lea r9,[rax+%2]
    cmp r9,r8
    ja %%reduce
%if %2 = 8
    vmovups ymm1,[rcx+rax*4]
    vmulps ymm1,ymm1,[rdx+rax*4]
    vaddps ymm0,ymm0,ymm1
%else
    movups xmm1,[rcx+rax*4]
    movups xmm2,[rdx+rax*4]
    mulps xmm1,xmm2
    addps xmm0,xmm1
%endif
    add rax,%2
    jmp %%vector
%%reduce:
%if %2 = 8
    vextractf128 xmm1,ymm0,1
    vaddps xmm0,xmm0,xmm1
%endif
    movaps xmm1,xmm0
    movhlps xmm1,xmm0
    addps xmm0,xmm1
    movaps xmm1,xmm0
    shufps xmm1,xmm1,1
    addss xmm0,xmm1
%%scalar:
    cmp rax,r8
    jae %%done
    movss xmm1,[rcx+rax*4]
    mulss xmm1,[rdx+rax*4]
    addss xmm0,xmm1
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
DOT sse2,4
DOT avx2,8

%macro MIX 2
global ta_am_mix_%1
ta_am_mix_%1:
    mov r10,[rsp+40] ; incoming gain
    mov r11,[rsp+48] ; samples
    xor eax,eax
%%vector:
    lea rax,[rax+%2]
    cmp rax,r11
    ja %%scalar_start
    sub rax,%2
%if %2 = 8
    vmovups ymm0,[rdx+rax*4]
    vmulps ymm0,ymm0,[r9+rax*4]
    vmovups ymm1,[r8+rax*4]
    vmulps ymm1,ymm1,[r10+rax*4]
    vaddps ymm0,ymm0,ymm1
    vmovups [rcx+rax*4],ymm0
%else
    movups xmm0,[rdx+rax*4]
    movups xmm2,[r9+rax*4]
    mulps xmm0,xmm2
    movups xmm1,[r8+rax*4]
    movups xmm2,[r10+rax*4]
    mulps xmm1,xmm2
    addps xmm0,xmm1
    movups [rcx+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar_start:
    sub rax,%2
%%scalar:
    cmp rax,r11
    jae %%done
    movss xmm0,[rdx+rax*4]
    mulss xmm0,[r9+rax*4]
    movss xmm1,[r8+rax*4]
    mulss xmm1,[r10+rax*4]
    addss xmm0,xmm1
    movss [rcx+rax*4],xmm0
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
MIX sse2,4
MIX avx2,8

%macro LINEAR 2
global ta_am_linear_%1
ta_am_linear_%1:
    test r9,r9
    jz %%done
    movaps xmm3,xmm2
    subss xmm3,xmm1
    lea rax,[r9-1]
    test rax,rax
    jz %%one
    cvtsi2ss xmm0,rax
    divss xmm3,xmm0
%if %2 = 8
    vbroadcastss ymm3,xmm3
    vbroadcastss ymm1,xmm1
%else
    shufps xmm3,xmm3,0
    shufps xmm1,xmm1,0
%endif
    xor eax,eax
%%vector:
    lea r10,[rax+%2]
    cmp r10,r9
    ja %%scalar
%if %2 = 8
    vcvtsi2ss xmm0,xmm0,rax
    vbroadcastss ymm0,xmm0
    vaddps ymm0,ymm0,[indices8]
    vmulps ymm0,ymm0,ymm3
    vaddps ymm0,ymm0,ymm1
    vmovups [rcx+rax*4],ymm0
%else
    cvtsi2ss xmm0,rax
    shufps xmm0,xmm0,0
    addps xmm0,[indices4]
    mulps xmm0,xmm3
    addps xmm0,xmm1
    movups [rcx+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar:
    cmp rax,r9
    jae %%done
    cvtsi2ss xmm0,rax
    mulss xmm0,xmm3
    addss xmm0,xmm1
    movss [rcx+rax*4],xmm0
    inc rax
    jmp %%scalar
%%one:
    movss [rcx],xmm1
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
LINEAR sse2,4
LINEAR avx2,8

%macro BUTTERFLY 2
global ta_am_butterfly_%1
ta_am_butterfly_%1:
    mov r10,[rsp+40]
    mov r11,[rsp+48]
    xor eax,eax
%%vector:
    add rax,%2
    cmp rax,[rsp+56]
    ja %%scalar_start
    sub rax,%2
%if %2 = 8
    vmovups ymm0,[r8+rax*4]
    vmulps ymm0,ymm0,[r10+rax*4]
    vmovups ymm1,[r9+rax*4]
    vmulps ymm1,ymm1,[r11+rax*4]
    vsubps ymm0,ymm0,ymm1
    vmovups ymm2,[r8+rax*4]
    vmulps ymm2,ymm2,[r11+rax*4]
    vmovups ymm3,[r9+rax*4]
    vmulps ymm3,ymm3,[r10+rax*4]
    vaddps ymm2,ymm2,ymm3
    vmovups ymm4,[rcx+rax*4]
    vaddps ymm1,ymm4,ymm0
    vsubps ymm4,ymm4,ymm0
    vmovups [rcx+rax*4],ymm1
    vmovups [r8+rax*4],ymm4
    vmovups ymm5,[rdx+rax*4]
    vaddps ymm3,ymm5,ymm2
    vsubps ymm5,ymm5,ymm2
    vmovups [rdx+rax*4],ymm3
    vmovups [r9+rax*4],ymm5
%else
    movups xmm0,[r8+rax*4]
    movups xmm4,[r10+rax*4]
    mulps xmm0,xmm4
    movups xmm1,[r9+rax*4]
    movups xmm5,[r11+rax*4]
    mulps xmm1,xmm5
    subps xmm0,xmm1
    movups xmm2,[r8+rax*4]
    mulps xmm2,xmm5
    movups xmm3,[r9+rax*4]
    mulps xmm3,xmm4
    addps xmm2,xmm3
    movups xmm4,[rcx+rax*4]
    movaps xmm1,xmm4
    addps xmm1,xmm0
    subps xmm4,xmm0
    movups [rcx+rax*4],xmm1
    movups [r8+rax*4],xmm4
    movups xmm5,[rdx+rax*4]
    movaps xmm3,xmm5
    addps xmm3,xmm2
    subps xmm5,xmm2
    movups [rdx+rax*4],xmm3
    movups [r9+rax*4],xmm5
%endif
    add rax,%2
    jmp %%vector
%%scalar_start:
    sub rax,%2
%%scalar:
    cmp rax,[rsp+56]
    jae %%done
    movss xmm0,[r8+rax*4]
    mulss xmm0,[r10+rax*4]
    movss xmm1,[r9+rax*4]
    mulss xmm1,[r11+rax*4]
    subss xmm0,xmm1
    movss xmm2,[r8+rax*4]
    mulss xmm2,[r11+rax*4]
    movss xmm3,[r9+rax*4]
    mulss xmm3,[r10+rax*4]
    addss xmm2,xmm3
    movss xmm4,[rcx+rax*4]
    movaps xmm1,xmm4
    addss xmm1,xmm0
    subss xmm4,xmm0
    movss [rcx+rax*4],xmm1
    movss [r8+rax*4],xmm4
    movss xmm5,[rdx+rax*4]
    movaps xmm3,xmm5
    addss xmm3,xmm2
    subss xmm5,xmm2
    movss [rdx+rax*4],xmm3
    movss [r9+rax*4],xmm5
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
BUTTERFLY sse2,4
BUTTERFLY avx2,8

%macro GEMM 2
global ta_am_gemm_%1
ta_am_gemm_%1:
    push rbx
    push rsi
    push rdi
    push r12
    push r13
    push r14
    push r15
    mov r12,rcx
    mov r13,rdx
    mov r14,r8
    mov r15,r9
    mov rbx,[rsp+96] ; K
    mov rsi,[rsp+104] ; N
%%row:
    test r15,r15
    jz %%done
    xor eax,eax
    xorps xmm0,xmm0
%%clear:
    cmp rax,rsi
    jae %%k_start
    movss [r14+rax*4],xmm0
    inc rax
    jmp %%clear
%%k_start:
    xor edi,edi
%%k:
    cmp rdi,rbx
    jae %%next_row
    mov rdx,rdi
    imul rdx,rsi
    lea rdx,[r13+rdx*4]
    movss xmm2,[r12+rdi*4]
%if %2 = 8
    vbroadcastss ymm2,xmm2
%else
    shufps xmm2,xmm2,0
%endif
    xor eax,eax
%%vector:
    lea r10,[rax+%2]
    cmp r10,rsi
    ja %%scalar
%if %2 = 8
    vmulps ymm0,ymm2,[rdx+rax*4]
    vaddps ymm0,ymm0,[r14+rax*4]
    vmovups [r14+rax*4],ymm0
%else
    movups xmm0,[rdx+rax*4]
    mulps xmm0,xmm2
    movups xmm1,[r14+rax*4]
    addps xmm0,xmm1
    movups [r14+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar:
    cmp rax,rsi
    jae %%next_k
    movss xmm0,[rdx+rax*4]
    mulss xmm0,xmm2
    addss xmm0,[r14+rax*4]
    movss [r14+rax*4],xmm0
    inc rax
    jmp %%scalar
%%next_k:
    inc rdi
    jmp %%k
%%next_row:
    lea r12,[r12+rbx*4]
    lea r14,[r14+rsi*4]
    dec r15
    jmp %%row
%%done:
%if %2 = 8
    vzeroupper
%endif
    pop r15
    pop r14
    pop r13
    pop r12
    pop rdi
    pop rsi
    pop rbx
    ret
ta_am_gemm_%1_end:
section .xdata rdata align=4
ta_am_gemm_%1_unwind:
    db 1,11,7,0
    db 11,0xf0,9,0xe0,7,0xd0,5,0xc0,3,0x70,2,0x60,1,0x30,0,0
section .pdata rdata align=4
    dd ta_am_gemm_%1 wrt ..imagebase
    dd ta_am_gemm_%1_end wrt ..imagebase
    dd ta_am_gemm_%1_unwind wrt ..imagebase
section .text align=16
%endmacro
GEMM sse2,4
GEMM avx2,8

%macro BINARY 2
global ta_am_binary_%1
ta_am_binary_%1:
    mov r11d,[rsp+40]
    xor eax,eax
%%vector:
    lea r10,[rax+%2]
    cmp r10,r9
    ja %%scalar
%if %2 = 8
    vmovups ymm0,[rdx+rax*4]
    vmovups ymm1,[r8+rax*4]
    test r11d,r11d
    jz %%add
    cmp r11d,1
    je %%mul
    vdivps ymm0,ymm0,ymm1
    jmp %%store
%%add: vaddps ymm0,ymm0,ymm1
    jmp %%store
%%mul: vmulps ymm0,ymm0,ymm1
%%store: vmovups [rcx+rax*4],ymm0
%else
    movups xmm0,[rdx+rax*4]
    movups xmm1,[r8+rax*4]
    test r11d,r11d
    jz %%add
    cmp r11d,1
    je %%mul
    divps xmm0,xmm1
    jmp %%store
%%add: addps xmm0,xmm1
    jmp %%store
%%mul: mulps xmm0,xmm1
%%store: movups [rcx+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar:
    cmp rax,r9
    jae %%done
    movss xmm0,[rdx+rax*4]
    test r11d,r11d
    jz %%sadd
    cmp r11d,1
    je %%smul
    divss xmm0,[r8+rax*4]
    jmp %%sstore
%%sadd: addss xmm0,[r8+rax*4]
    jmp %%sstore
%%smul: mulss xmm0,[r8+rax*4]
%%sstore: movss [rcx+rax*4],xmm0
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
BINARY sse2,4
BINARY avx2,8

%macro AFFINE 2
global ta_am_affine_%1
ta_am_affine_%1:
    mov r9,[rsp+40]
    xor eax,eax
%if %2 = 8
    vbroadcastss ymm2,xmm2
    vbroadcastss ymm3,xmm3
%else
    shufps xmm2,xmm2,0
    shufps xmm3,xmm3,0
%endif
%%vector:
    lea r10,[rax+%2]
    cmp r10,r9
    ja %%scalar
%if %2 = 8
    vmulps ymm0,ymm2,[rdx+rax*4]
    vaddps ymm0,ymm0,ymm3
    vmovups [rcx+rax*4],ymm0
%else
    movups xmm0,[rdx+rax*4]
    mulps xmm0,xmm2
    addps xmm0,xmm3
    movups [rcx+rax*4],xmm0
%endif
    add rax,%2
    jmp %%vector
%%scalar:
    cmp rax,r9
    jae %%done
    movss xmm0,[rdx+rax*4]
    mulss xmm0,xmm2
    addss xmm0,xmm3
    movss [rcx+rax*4],xmm0
    inc rax
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
AFFINE sse2,4
AFFINE avx2,8

; Scalar exp range reduction, sixth-order residual polynomial. Input XMM0,
; output XMM0; clobbers XMM1/2 and R11D. No libm/compiler-generated body.
; Used on bounded activations; tails below -87 saturate to zero.
%macro EXP_SCALAR 0
    comiss xmm0,[exp_lo]
    jb %%zero
    minss xmm0,[exp_hi]
    movaps xmm1,xmm0
    mulss xmm1,[log2e]
    xorps xmm2,xmm2
    comiss xmm1,xmm2
    jb %%negative
    addss xmm1,[half]
    jmp %%round
%%negative: addss xmm1,[minus_half]
%%round:
    cvttss2si r11d,xmm1
    cvtsi2ss xmm1,r11d
    movaps xmm2,xmm1
    mulss xmm1,[ln2hi]
    mulss xmm2,[ln2lo]
    subss xmm0,xmm1
    subss xmm0,xmm2
    movss xmm1,[e6]
    mulss xmm1,xmm0
    addss xmm1,[e5]
    mulss xmm1,xmm0
    addss xmm1,[e4]
    mulss xmm1,xmm0
    addss xmm1,[e3]
    mulss xmm1,xmm0
    addss xmm1,[half]
    mulss xmm1,xmm0
    addss xmm1,[one]
    mulss xmm1,xmm0
    addss xmm1,[one]
    add r11d,127
    shl r11d,23
    movd xmm0,r11d
    mulss xmm0,xmm1
    jmp %%done
%%zero: xorps xmm0,xmm0
%%done:
%endmacro
; Positive double logarithm. The atanh series on the mantissa has |y|<=1/3.
; log1p uses a double addition before decomposition to retain tiny inputs.
%macro LOG_DOUBLE 0
    xorpd xmm1,xmm1
    comisd xmm0,xmm1
    jb %%invalid
    je %%zero
    movq r11,xmm0
    mov r10,r11
    shr r10,52
    cmp r10d,2047
    jae %%infinite
    sub r10d,1023
    shl r11,12
    shr r11,12
    movq xmm0,r11
    movq xmm1,[double_one]
    orpd xmm0,xmm1
    movapd xmm2,xmm0
    subsd xmm0,xmm1
    addsd xmm2,xmm1
    divsd xmm0,xmm2
    movapd xmm2,xmm0
    mulsd xmm2,xmm2
    movsd xmm3,[log_c13]
    mulsd xmm3,xmm2
    addsd xmm3,[log_c11]
    mulsd xmm3,xmm2
    addsd xmm3,[log_c9]
    mulsd xmm3,xmm2
    addsd xmm3,[log_c7]
    mulsd xmm3,xmm2
    addsd xmm3,[log_c5]
    mulsd xmm3,xmm2
    addsd xmm3,[log_c3]
    mulsd xmm3,xmm2
    addsd xmm3,[double_one]
    mulsd xmm0,xmm3
    mulsd xmm0,[double_two]
    cvtsi2sd xmm1,r10d
    mulsd xmm1,[double_ln2]
    addsd xmm0,xmm1
    cvtsd2ss xmm0,xmm0
    jmp %%done
%%zero: movss xmm0,[log_negative_infinity]
    jmp %%done
%%invalid: movss xmm0,[log_nan]
    jmp %%done
%%infinite: cvtsd2ss xmm0,xmm0
%%done:
%endmacro
%macro UNARY 1
global ta_am_unary_%1
ta_am_unary_%1:
    xor eax,eax
%%loop:
    cmp rax,r8
    jae %%done
    movss xmm0,[rdx+rax*4]
    test r9d,r9d
    jz %%exp
    cmp r9d,1
    je %%erf
    cmp r9d,2
    je %%sigmoid
    cmp r9d,3
    je %%relu
    cmp r9d,5
    je %%sqrt
    cmp r9d,6
    je %%log
    cmp r9d,7
    je %%log1p
    movd xmm1,[sign_mask]
    xorps xmm0,xmm1
    jmp %%store
%%sqrt:
    sqrtss xmm0,xmm0
    jmp %%store
%%log1p:
    cvtss2sd xmm0,xmm0
    addsd xmm0,[double_one]
    LOG_DOUBLE
    jmp %%store
%%log:
    cvtss2sd xmm0,xmm0
    LOG_DOUBLE
    jmp %%store
%%relu:
    xorps xmm1,xmm1
    maxss xmm0,xmm1
    jmp %%store
%%sigmoid:
    movd r10d,xmm0
    movd xmm1,[abs_mask]
    andps xmm0,xmm1
    movd xmm1,[sign_mask]
    xorps xmm0,xmm1
    EXP_SCALAR
    movaps xmm3,xmm0
    addss xmm3,[one]
    test r10d,0x80000000
    jnz %%signeg
    movss xmm0,[one]
%%signeg: divss xmm0,xmm3
    jmp %%store
%%erf:
    movd r10d,xmm0
    movd xmm1,[abs_mask]
    andps xmm0,xmm1
    movaps xmm3,xmm0
    mulss xmm3,[erf_p]
    addss xmm3,[one]
    movss xmm4,[one]
    divss xmm4,xmm3
    movss xmm3,[erf_a5]
    mulss xmm3,xmm4
    addss xmm3,[erf_a4]
    mulss xmm3,xmm4
    addss xmm3,[erf_a3]
    mulss xmm3,xmm4
    addss xmm3,[erf_a2]
    mulss xmm3,xmm4
    addss xmm3,[erf_a1]
    mulss xmm3,xmm4
    mulss xmm0,xmm0
    movd xmm1,[sign_mask]
    xorps xmm0,xmm1
    EXP_SCALAR
    mulss xmm0,xmm3
    movss xmm1,[one]
    subss xmm1,xmm0
    and r10d,0x80000000
    movd xmm0,r10d
    xorps xmm0,xmm1
    jmp %%store
%%exp:
    EXP_SCALAR
%%store:
    movss [rcx+rax*4],xmm0
    inc rax
    jmp %%loop
%%done: ret
%endmacro
UNARY sse2
UNARY avx2

; Two complex products per SSE2 iteration. The AVX2 path shares this primitive;
; its bulk FFT/OLA/normalisation uses the wider kernels above.
global ta_am_complex_sse2,ta_am_complex_avx2
ta_am_complex_avx2:
ta_am_complex_sse2:
    xor eax,eax
.complex_vector:
    lea r10,[rax+2]
    cmp r10,r9
    ja .complex_tail
    movups xmm0,[rdx+rax*8]
    movups xmm1,[r8+rax*8]
    cmp dword [rsp+40],0
    je .complex_positive
    xorps xmm1,[imaginary_sign]
.complex_positive:
    movaps xmm2,xmm0
    shufps xmm2,xmm2,0xa0 ; real real real real
    shufps xmm0,xmm0,0xf5 ; imag imag imag imag
    mulps xmm2,xmm1
    shufps xmm1,xmm1,0xb1 ; swap real/imag per pair
    mulps xmm0,xmm1
    xorps xmm0,[real_sign]
    addps xmm2,xmm0
    movups [rcx+rax*8],xmm2
    add rax,2
    jmp .complex_vector
.complex_tail:
    cmp rax,r9
    jae .complex_done
    movq xmm0,[rdx+rax*8]
    movq xmm1,[r8+rax*8]
    cmp dword [rsp+40],0
    je .complex_tail_positive
    xorps xmm1,[imaginary_sign]
.complex_tail_positive:
    movaps xmm2,xmm0
    shufps xmm2,xmm2,0xa0
    shufps xmm0,xmm0,0xf5
    mulps xmm2,xmm1
    shufps xmm1,xmm1,0xb1
    mulps xmm0,xmm1
    xorps xmm0,[real_sign]
    addps xmm2,xmm0
    movq [rcx+rax*8],xmm2
.complex_done: ret

; Strided reductions preserve the reference accumulation order.
global ta_am_sum_sse2,ta_am_sum_avx2,ta_am_maximum_sse2,ta_am_maximum_avx2
ta_am_sum_avx2:
ta_am_sum_sse2:
    xorpd xmm0,xmm0
    shl r8,2
.sum_loop:
    test rdx,rdx
    jz .sum_done
    movss xmm1,[rcx]
    cvtss2sd xmm1,xmm1
    addsd xmm0,xmm1
    add rcx,r8
    dec rdx
    jmp .sum_loop
.sum_done: ret
ta_am_maximum_avx2:
ta_am_maximum_sse2:
    movss xmm0,[negative_max]
    shl r8,2
.max_loop:
    test rdx,rdx
    jz .max_done
    maxss xmm0,[rcx]
    add rcx,r8
    dec rdx
    jmp .max_loop
.max_done: ret

global ta_am_clamp_sse2,ta_am_clamp_avx2
ta_am_clamp_avx2:
ta_am_clamp_sse2:
    mov r8,[rsp+40]
    xor eax,eax
.clamp_loop:
    cmp rax,r8
    jae .clamp_done
    movss xmm0,[rdx+rax*4]
    maxss xmm0,xmm2
    minss xmm0,xmm3
    movss [rcx+rax*4],xmm0
    inc rax
    jmp .clamp_loop
.clamp_done: ret

%macro WINDOW 2
global ta_am_window_%1
ta_am_window_%1:
    mov r11,[rsp+40]
    mov eax,[rsp+48]
    cmp r11,1
    jne %%strided
%%vector:
    cmp r9,%2
    jb %%strided
%if %2 = 8
    vmovups ymm0,[rdx]
    vmulps ymm0,ymm0,[r8]
    test eax,eax
    jz %%vstore
    vaddps ymm0,ymm0,[rcx]
%%vstore: vmovups [rcx],ymm0
%else
    movups xmm0,[rdx]
    movups xmm1,[r8]
    mulps xmm0,xmm1
    test eax,eax
    jz %%vstore
    movups xmm1,[rcx]
    addps xmm0,xmm1
%%vstore: movups [rcx],xmm0
%endif
    add rcx,%2*4
    add rdx,%2*4
    add r8,%2*4
    sub r9,%2
    jmp %%vector
%%strided:
    shl r11,2
%%scalar:
    test r9,r9
    jz %%done
    movss xmm0,[rdx]
    mulss xmm0,[r8]
    test eax,eax
    jz %%copy
    addss xmm0,[rcx]
    movss [rcx],xmm0
    add rcx,r11
    add rdx,4
    jmp %%next
%%copy:
    movss [rcx],xmm0
    add rcx,4
    add rdx,r11
%%next:
    add r8,4
    dec r9
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
WINDOW sse2,4
WINDOW avx2,8

%macro NORMALISE 2
global ta_am_normalise_%1
ta_am_normalise_%1:
    cmp r9,1
    jne %%strided
%if %2 = 8
    vbroadcastss ymm2,[normalisation_floor]
%else
    movss xmm2,[normalisation_floor]
    shufps xmm2,xmm2,0
%endif
%%vector:
    cmp r8,%2
    jb %%strided
%if %2 = 8
    vmovups ymm0,[rcx]
    vmovups ymm1,[rdx]
    vmaxps ymm1,ymm1,ymm2
    vdivps ymm0,ymm0,ymm1
    vmovups [rcx],ymm0
%else
    movups xmm0,[rcx]
    movups xmm1,[rdx]
    maxps xmm1,xmm2
    divps xmm0,xmm1
    movups [rcx],xmm0
%endif
    add rcx,%2*4
    add rdx,%2*4
    sub r8,%2
    jmp %%vector
%%strided:
    shl r9,2
%%scalar:
    test r8,r8
    jz %%done
    movss xmm0,[rcx]
    movss xmm1,[rdx]
    maxss xmm1,[normalisation_floor]
    divss xmm0,xmm1
    movss [rcx],xmm0
    add rcx,r9
    add rdx,4
    dec r8
    jmp %%scalar
%%done:
%if %2 = 8
    vzeroupper
%endif
    ret
%endmacro
NORMALISE sse2,4
NORMALISE avx2,8

%macro SIN_POLY 0
    movaps xmm1,xmm0
    mulss xmm1,xmm1
    movss xmm3,[sin_c12]
    mulss xmm3,xmm1
    addss xmm3,[sin_c10]
    mulss xmm3,xmm1
    addss xmm3,[sin_c8]
    mulss xmm3,xmm1
    addss xmm3,[sin_c6]
    mulss xmm3,xmm1
    addss xmm3,[sin_c4]
    mulss xmm3,xmm1
    addss xmm3,[sin_c2]
    mulss xmm3,xmm1
    addss xmm3,[one]
    mulss xmm0,xmm3
%endmacro
global ta_am_crossfade_gain_sse2,ta_am_crossfade_gain_avx2
ta_am_crossfade_gain_avx2:
ta_am_crossfade_gain_sse2:
    xor eax,eax
    mov r8d,[rsp+40]
.gain_loop:
    cmp rax,r9
    jae .gain_done
    xorps xmm4,xmm4
    cmp r9,1
    jbe .gain_fraction
    lea r11,[r9-1]
    cvtsi2sd xmm4,rax
    cvtsi2sd xmm1,r11
    divsd xmm4,xmm1
    cvtsd2ss xmm4,xmm4
.gain_fraction:
    movss xmm0,[one]
    subss xmm0,xmm4
    mulss xmm0,[pi_half]
    SIN_POLY
    movaps xmm5,xmm0
    movaps xmm0,xmm4
    mulss xmm0,[pi_half]
    SIN_POLY
    movss xmm1,[one]
    subss xmm1,xmm2
    mulss xmm1,xmm4
    addss xmm1,xmm2
    mulss xmm0,xmm1
    test rax,rax
    jnz .gain_last_check
    movss xmm5,[one]
    xorps xmm0,xmm0
    jmp .gain_store
.gain_last_check:
    lea r11,[rax+1]
    cmp r11,r9
    jne .gain_store
    xorps xmm5,xmm5
    movss xmm0,[one]
.gain_store:
    xor r10d,r10d
.gain_channels:
    cmp r10d,r8d
    jae .gain_next
    movss [rcx],xmm5
    movss [rdx],xmm0
    add rcx,4
    add rdx,4
    inc r10d
    jmp .gain_channels
.gain_next:
    inc rax
    jmp .gain_loop
.gain_done: ret

global ta_am_source_at_sse2,ta_am_source_at_avx2
ta_am_source_at_avx2:
ta_am_source_at_sse2:
    cvtsi2sd xmm4,r9
    movsd xmm3,[rsp+40]
    minsd xmm3,xmm4
    xorpd xmm5,xmm5
    maxsd xmm3,xmm5
    movapd xmm5,xmm4
    mulsd xmm5,[double_ramp]
    comisd xmm3,xmm5
    ja .source_ramp
    cvtss2sd xmm1,xmm1
    mulsd xmm3,xmm1
    addsd xmm0,xmm3
    ret
.source_ramp:
    subss xmm2,xmm1
    cvtss2sd xmm2,xmm2
    cvtss2sd xmm1,xmm1
    subsd xmm3,xmm5
    subsd xmm4,xmm5
    mulsd xmm5,xmm1
    addsd xmm0,xmm5
    mulsd xmm1,xmm3
    addsd xmm0,xmm1
    mulsd xmm2,xmm3
    mulsd xmm2,xmm3
    addsd xmm4,xmm4
    divsd xmm2,xmm4
    addsd xmm0,xmm2
    ret

; Complex xmm0*xmm1 -> xmm0. XMM4/5 survive; XMM1/2/3 are scratch.
%macro CMUL 1
%if %1 = 1
    xorps xmm1,[imaginary_sign]
%endif
    movaps xmm2,xmm0
    shufps xmm2,xmm2,0xa0
    shufps xmm0,xmm0,0xf5
    mulps xmm2,xmm1
    shufps xmm1,xmm1,0xb1
    mulps xmm0,xmm1
    xorps xmm0,[real_sign]
    addps xmm0,xmm2
%endmacro
%macro PHASE_NORMALISE 0
    movaps xmm2,xmm0
    mulps xmm2,xmm2
    movaps xmm3,xmm2
    shufps xmm3,xmm3,0xb1
    addss xmm2,xmm3
    comiss xmm2,[epsilon]
    ja %%scale
    movaps xmm0,xmm1
    movaps xmm2,xmm1
    mulps xmm2,xmm2
    movaps xmm3,xmm2
    shufps xmm3,xmm3,0xb1
    addss xmm2,xmm3
    addss xmm2,[epsilon]
%%scale:
    divss xmm4,xmm2
    sqrtss xmm4,xmm4
    shufps xmm4,xmm4,0
    mulps xmm0,xmm4
%endmacro
global ta_am_phase_sse2,ta_am_phase_avx2
ta_am_phase_avx2:
ta_am_phase_sse2:
    push rbx
    push rsi
    push rdi
    push r12
    push r13
    push r14
    push r15
    sub rsp,80
    mov rbx,rcx
    mov r12,[rbx]
    xor esi,esi
    xor edi,edi
    mov r15d,[rbx+8]
    imul r15,r12
.phase_horizontal:
    cmp rsi,r15
    jae .phase_vertical_start
    mov r13,[rbx+24]
    mov r14,[rbx+40]
    mov rax,[rbx+48]
    movq xmm0,[r13+rsi*8]
    mulps xmm0,xmm0
    movaps xmm1,xmm0
    shufps xmm1,xmm1,0xb1
    addss xmm0,xmm1
    movaps xmm4,xmm0
    mov rdx,[rbx+56]
    movss [rdx+rsi*4],xmm4
    mov rdx,[rbx+32]
    movq xmm0,[rdx+rsi*8]
    movq xmm1,[rax+rdi*8]
    CMUL 0
    movq [rsp+48],xmm0
    movq xmm0,[r14+rsi*8]
    movq xmm1,[rax+rdi*8]
    CMUL 0
    movaps xmm5,xmm0
    movq xmm0,[r13+rsi*8]
    movq xmm1,[rsp+48]
    CMUL 1
    movaps xmm1,xmm0
    movaps xmm0,xmm5
    CMUL 0
    mov rdx,[rbx+64]
    maxss xmm4,[rdx+rsi*4]
    addss xmm4,[epsilon]
    movss xmm1,[one]
    divss xmm1,xmm4
    shufps xmm1,xmm1,0
    mulps xmm0,xmm1
    movq [r14+rsi*8],xmm0
    inc rsi
    inc rdi
    cmp rdi,r12
    jb .phase_horizontal
    xor edi,edi
    jmp .phase_horizontal
.phase_vertical_start:
    xor esi,esi
.phase_vertical:
    cmp rsi,r12
    jae .phase_done
    mov rdx,[rbx+56]
    movss xmm5,[rdx+rsi*4]
    xor edi,edi
    mov r10d,1
    lea r11,[rsi+r12]
.phase_max_channel:
    cmp r10d,[rbx+8]
    jae .phase_selected
    movss xmm0,[rdx+r11*4]
    comiss xmm0,xmm5
    jbe .phase_max_next
    movaps xmm5,xmm0
    mov edi,r10d
.phase_max_next:
    inc r10d
    add r11,r12
    jmp .phase_max_channel
.phase_selected:
    mov [rsp+64],edi
    mov r15,rdi
    imul r15,r12
    mov r13,[rbx+24]
    mov r14,[rbx+40]
    lea r13,[r13+r15*8]
    lea r14,[r14+r15*8]
    add r15,rsi
    mov qword [rsp+32],0
    test rsi,rsi
    jz .phase_long_lower
    cvtsi2sd xmm0,rsi
    cvtss2sd xmm1,[rbx+16]
    subsd xmm0,xmm1
    call ta_am_phase_fractional
    movq xmm0,[r13+rsi*8]
    CMUL 1
    movaps xmm1,xmm0
    movq xmm0,[r14+rsi*8-8]
    CMUL 0
    addps xmm0,[rsp+32]
    movq [rsp+32],xmm0
.phase_long_lower:
    mov eax,[rbx+12]
    cmp rsi,rax
    jb .phase_upper
    cvtsi2sd xmm0,rsi
    cvtsi2ss xmm1,eax
    mulss xmm1,[rbx+16]
    cvtss2sd xmm1,xmm1
    subsd xmm0,xmm1
    call ta_am_phase_fractional
    movq xmm0,[r13+rsi*8]
    CMUL 1
    movaps xmm1,xmm0
    mov eax,[rbx+12]
    mov r11,rsi
    sub r11,rax
    movq xmm0,[r14+r11*8]
    CMUL 0
    addps xmm0,[rsp+32]
    movq [rsp+32],xmm0
.phase_upper:
    lea r11,[rsi+1]
    cmp r11,r12
    jae .phase_long_upper
    cvtsi2sd xmm0,r11
    cvtss2sd xmm1,[rbx+16]
    subsd xmm0,xmm1
    call ta_am_phase_fractional
    movq xmm0,[r13+rsi*8+8]
    CMUL 1
    movaps xmm1,xmm0
    movq xmm0,[r14+rsi*8+8]
    CMUL 1
    addps xmm0,[rsp+32]
    movq [rsp+32],xmm0
.phase_long_upper:
    mov eax,[rbx+12]
    lea r11,[rsi+rax]
    cmp r11,r12
    jae .phase_normalise_selected
    cvtsi2sd xmm0,r11
    cvtsi2ss xmm1,eax
    mulss xmm1,[rbx+16]
    cvtss2sd xmm1,xmm1
    subsd xmm0,xmm1
    call ta_am_phase_fractional
    mov eax,[rbx+12]
    lea r11,[rsi+rax]
    movq xmm0,[r13+r11*8]
    CMUL 1
    movaps xmm1,xmm0
    movq xmm0,[r14+r11*8]
    CMUL 1
    addps xmm0,[rsp+32]
    movq [rsp+32],xmm0
.phase_normalise_selected:
    movq xmm0,[rsp+32]
    movq xmm1,[r13+rsi*8]
    mov rdx,[rbx+56]
    movss xmm4,[rdx+r15*4]
    PHASE_NORMALISE
    movq [r14+rsi*8],xmm0
    xor edi,edi
.phase_link_channel:
    cmp edi,[rbx+8]
    jae .phase_next_bin
    cmp edi,[rsp+64]
    je .phase_next_channel
    mov rax,rdi
    imul rax,r12
    add rax,rsi
    mov rdx,[rbx+24]
    movq xmm0,[rdx+rax*8]
    movq xmm1,[r13+rsi*8]
    movaps xmm2,xmm0
    cmpeqps xmm2,xmm1
    movmskps r10d,xmm2
    and r10d,3
    cmp r10d,3
    je .phase_copy_channel
    xorps xmm1,[both_sign]
    movaps xmm2,xmm0
    cmpeqps xmm2,xmm1
    movmskps r10d,xmm2
    and r10d,3
    cmp r10d,3
    je .phase_negate_channel
    movq xmm1,[r13+rsi*8]
    CMUL 1
    movaps xmm1,xmm0
    movq xmm0,[r14+rsi*8]
    CMUL 0
    movq xmm1,[rdx+rax*8]
    mov r10,[rbx+56]
    movss xmm4,[r10+rax*4]
    PHASE_NORMALISE
    jmp .phase_store_channel
.phase_copy_channel:
    movq xmm0,[r14+rsi*8]
    jmp .phase_store_channel
.phase_negate_channel:
    movq xmm0,[r14+rsi*8]
    xorps xmm0,[both_sign]
.phase_store_channel:
    mov r10,[rbx+40]
    movq [r10+rax*8],xmm0
.phase_next_channel:
    inc edi
    jmp .phase_link_channel
.phase_next_bin:
    inc rsi
    jmp .phase_vertical
.phase_done:
    add rsp,80
    pop r15
    pop r14
    pop r13
    pop r12
    pop rdi
    pop rsi
    pop rbx
    ret
ta_am_phase_end:
section .xdata rdata align=4
ta_am_phase_unwind:
    db 1,15,8,0
    db 15,0x92,11,0xf0,9,0xe0,7,0xd0,5,0xc0,3,0x70,2,0x60,1,0x30
section .pdata rdata align=4
    dd ta_am_phase_sse2 wrt ..imagebase
    dd ta_am_phase_end wrt ..imagebase
    dd ta_am_phase_unwind wrt ..imagebase
section .text align=16
; Private leaf: input position XMM0, current channel R13, bins R12.
; Returns interpolated complex pair XMM1. R10/R11 and XMM0..4 are scratch.
ta_am_phase_fractional:
    cvttsd2si r10,xmm0
    cvtsi2sd xmm1,r10
    comisd xmm0,xmm1
    jae .fraction_low
    dec r10
    cvtsi2sd xmm1,r10
.fraction_low:
    subsd xmm0,xmm1
    cvtsd2ss xmm4,xmm0
    shufps xmm4,xmm4,0
    xorps xmm1,xmm1
    cmp r10,r12
    jae .fraction_high
    movq xmm1,[r13+r10*8]
.fraction_high:
    lea r11,[r10+1]
    xorps xmm2,xmm2
    cmp r11,r12
    jae .fraction_interpolate
    movq xmm2,[r13+r11*8]
.fraction_interpolate:
    subps xmm2,xmm1
    mulps xmm2,xmm4
    addps xmm1,xmm2
    ret

; Ordered scalar reductions deliberately preserve C11 float/double order.
global ta_am_reduce_sse2,ta_am_reduce_avx2
ta_am_reduce_sse2:
ta_am_reduce_avx2:
    xorps xmm0,xmm0
    shl r8,2
    test rdx,rdx
    jz .reduce_done
.reduce_loop:
    movss xmm1,[rcx]
    test r9d,r9d
    jz .reduce_add
    mulss xmm1,xmm1
.reduce_add:
    addss xmm0,xmm1
    add rcx,r8
    dec rdx
    jnz .reduce_loop
.reduce_done:
    ret

global ta_am_moments_sse2,ta_am_moments_avx2
ta_am_moments_sse2:
ta_am_moments_avx2:
    xorpd xmm0,xmm0
    xorps xmm3,xmm3
    test rdx,rdx
    jz .moments_done
.moments_loop:
    movss xmm1,[rcx]
    cvtss2sd xmm2,xmm1
    mulsd xmm2,xmm2
    addsd xmm0,xmm2
    movss xmm2,[abs_mask]
    andps xmm1,xmm2
    maxss xmm3,xmm1
    add rcx,4
    dec rdx
    jnz .moments_loop
.moments_done:
    movsd [r8],xmm0
    movss [r9],xmm3
    ret

; Sequential filter state lives in a bounded stack frame, one float/channel.
; blend is the fifth Win64 argument; no runtime library or allocator calls.
global ta_am_lowpass_exit_sse2,ta_am_lowpass_exit_avx2
ta_am_lowpass_exit_avx2:
    jmp ta_am_lowpass_exit_sse2
ta_am_lowpass_exit_sse2:
    sub rsp,40
.filter_prologue:
    mov r11,[rsp+80]
    xorps xmm0,xmm0
    movups [rsp],xmm0
    movups [rsp+16],xmm0
    xor r10d,r10d
.filter_frame:
    cmp r10,rdx
    jae .filter_done
    movss xmm4,[r9+r10*4]
    movss xmm5,[r11+r10*4]
    xor eax,eax
.filter_channel:
    cmp eax,r8d
    jae .filter_next
    movss xmm0,[rcx+rax*4]
    movss xmm1,[rsp+rax*4]
    movaps xmm2,xmm0
    subss xmm2,xmm1
    mulss xmm2,xmm4
    addss xmm1,xmm2
    movss [rsp+rax*4],xmm1
    movss xmm2,[one]
    subss xmm2,xmm5
    mulss xmm0,xmm2
    mulss xmm1,xmm5
    addss xmm0,xmm1
    movss [rcx+rax*4],xmm0
    inc eax
    jmp .filter_channel
.filter_next:
    lea rcx,[rcx+r8*4]
    inc r10
    jmp .filter_frame
.filter_done:
    add rsp,40
    ret
ta_am_lowpass_exit_end:
section .xdata rdata align=4
ta_am_lowpass_exit_unwind:
    db 1,4,1,0
    db 4,0x42,0,0
section .pdata rdata align=4
    dd ta_am_lowpass_exit_sse2 wrt ..imagebase
    dd ta_am_lowpass_exit_end wrt ..imagebase
    dd ta_am_lowpass_exit_unwind wrt ..imagebase
section .text align=16

; Per-frame gains survive routing to a different channel layout. Struct offsets
; are asserted in C; scratch stores only geometry, never audio or allocations.
%macro FRAME_MIX 2
global ta_am_mix_frames_%1
ta_am_mix_frames_%1:
    sub rsp,40
%%prologue:
    mov rax,[rcx+40]
    mov [rsp],rax
    mov eax,[rcx+48]
    mov [rsp+8],eax
    mov eax,[rcx+52]
    shl rax,2
    mov [rsp+16],rax
    mov rdx,[rcx]
    mov r8,[rcx+8]
    mov r9,[rcx+16]
    mov r10,[rcx+24]
    mov r11,[rcx+32]
%%frame:
    cmp qword [rsp],0
    je %%done
%if %2 = 8
    vbroadcastss ymm2,[r10]
    vbroadcastss ymm3,[r11]
%else
    movss xmm2,[r10]
    shufps xmm2,xmm2,0
    movss xmm3,[r11]
    shufps xmm3,xmm3,0
%endif
    xor eax,eax
%%vector:
    lea ecx,[rax+%2]
    cmp ecx,[rsp+8]
    ja %%tail
%if %2 = 8
    vmulps ymm0,ymm2,[r8+rax*4]
    vmulps ymm1,ymm3,[r9+rax*4]
    vaddps ymm0,ymm0,ymm1
    vmovups [rdx+rax*4],ymm0
%else
    movups xmm0,[r8+rax*4]
    movups xmm1,[r9+rax*4]
    mulps xmm0,xmm2
    mulps xmm1,xmm3
    addps xmm0,xmm1
    movups [rdx+rax*4],xmm0
%endif
    add eax,%2
    jmp %%vector
%%tail:
%if %2 = 8
    vzeroupper
%endif
%%scalar:
    cmp eax,[rsp+8]
    jae %%next
    movss xmm0,[r8+rax*4]
    movss xmm1,[r9+rax*4]
    mulss xmm0,xmm2
    mulss xmm1,xmm3
    addss xmm0,xmm1
    movss [rdx+rax*4],xmm0
    inc eax
    jmp %%scalar
%%next:
    mov ecx,[rsp+8]
    lea rdx,[rdx+rcx*4]
    lea r8,[r8+rcx*4]
    lea r9,[r9+rcx*4]
    mov rcx,[rsp+16]
    add r10,rcx
    add r11,rcx
    dec qword [rsp]
    jmp %%frame
%%done:
%if %2 = 8
    vzeroupper
%endif
    add rsp,40
    ret
%%end:
section .xdata rdata align=4
%%unwind:
    db 1,4,1,0
    db 4,0x42,0,0
section .pdata rdata align=4
    dd ta_am_mix_frames_%1 wrt ..imagebase
    dd %%end wrt ..imagebase
    dd %%unwind wrt ..imagebase
section .text align=16
%endmacro
FRAME_MIX sse2,4
FRAME_MIX avx2,8

; Offline bidirectional look-ahead envelope. Dependency chains use the same
; handwritten SSE2 operations on both dispatch paths; no compiler assembly.
global ta_am_headroom_envelope_sse2,ta_am_headroom_envelope_avx2
ta_am_headroom_envelope_sse2:
ta_am_headroom_envelope_avx2:
    test rdx,rdx
    jz .headroom_done
    test r8d,r8d
    jz .headroom_done
    cvtsi2ss xmm3,r8d
    movss xmm0,[one]
    movaps xmm4,xmm3
    mulss xmm4,[headroom_release]
    divss xmm0,xmm4
    movss xmm1,[one]
    movaps xmm4,xmm3
    mulss xmm4,[headroom_attack]
    divss xmm1,xmm4
    movss xmm2,[one]
    mulss xmm3,[headroom_edge]
    divss xmm2,xmm3
    mov r9d,1
.headroom_forward:
    cmp r9,rdx
    jae .headroom_backward_init
    movss xmm3,[rcx+r9*4-4]
    addss xmm3,xmm0
    minss xmm3,[rcx+r9*4]
    movss [rcx+r9*4],xmm3
    inc r9
    jmp .headroom_forward
.headroom_backward_init:
    mov r9,rdx
    dec r9
.headroom_backward:
    test r9,r9
    jz .headroom_edges_init
    movss xmm3,[rcx+r9*4]
    addss xmm3,xmm1
    minss xmm3,[rcx+r9*4-4]
    movss [rcx+r9*4-4],xmm3
    dec r9
    jmp .headroom_backward
.headroom_edges_init:
    xor r9d,r9d
    xorps xmm5,xmm5
.headroom_edges:
    cmp r9,rdx
    jae .headroom_done
    cvtsi2ss xmm4,r9
    mulss xmm4,xmm2
    movss xmm3,[one]
    subss xmm3,xmm4
    maxss xmm3,xmm5
    mov r10,rdx
    sub r10,r9
    dec r10
    cvtsi2ss xmm4,r10
    mulss xmm4,xmm2
    movss xmm0,[one]
    subss xmm0,xmm4
    maxss xmm3,xmm0
    maxss xmm3,[rcx+r9*4]
    movss [rcx+r9*4],xmm3
    inc r9
    jmp .headroom_edges
.headroom_done:
    ret
